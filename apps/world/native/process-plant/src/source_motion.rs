//! One prospective cold SOURCE/cooling/mechanics residual. The cooling prefix
//! owns every existing water, material and thermal stock. Appended coordinates
//! own only actual finite mechanics, adiabatic apparatus heat, and the signed
//! water-to-mechanics work receipt. The caller owns the single finite ACT.A/B
//! support schedule and the one accepted integration clock.
use crate::{
    GRAVITY, absorber_motion as am, control_motion_forces as cf, control_source_geometry as cg,
    operating_network as on, source_cooling as sc,
};
use std::sync::Arc;

pub const WIDTH: usize = 8;
pub const BODY_Y: usize = 0;
pub const BODY_V: usize = 1;
pub const STEM_Y: usize = 2;
pub const STEM_V: usize = 3;
pub const REFERENCE_Y: usize = 4;
pub const JACK_HEAT: usize = 5;
pub const STEM_HEAT: usize = 6;
pub const SPIDER_HEAT: usize = 7;
pub const ROOTS_PER_CLUSTER: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Input {
    pub requested_rate_m_s: f64,
    /// Actual delivered total bank motive power, never a per-cluster rating.
    pub motive_power_w: f64,
    /// Actual delivered total BANK.HOLD power removed from ACT.A other export.
    pub holding_power_w: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_mode_record_round_trips_all_cluster_branches_and_input_bits() {
        let mut mode = Mode::new(
            Input {
                requested_rate_m_s: 0.007999999999999997,
                motive_power_w: 999.9999999999999,
                holding_power_w: 19.999999999999996,
            },
            52,
        )
        .unwrap();
        let regulators = [
            am::RegulatorBranch::ApproachPositive,
            am::RegulatorBranch::ApproachNegative,
            am::RegulatorBranch::Track,
            am::RegulatorBranch::HoldPositive,
            am::RegulatorBranch::HoldNegative,
            am::RegulatorBranch::HoldRest,
            am::RegulatorBranch::Open,
        ];
        for k in 0..52 {
            // Storage coverage of every typed enum. The actual restored
            // state/input force graph is still admitted by Model::evaluate.
            mode.branches[k] = am::TrialBranch {
                regulator: regulators[k % regulators.len()],
                joint: if k % 2 == 0 {
                    am::JointMode::Contact
                } else {
                    am::JointMode::Separated
                },
            };
            mode.geometry[k] = GeometryBranch {
                body_right: k % 2 == 0,
                stem_right: k % 3 == 0,
                seated: k % 5 == 0,
            };
        }
        let record = mode.snapshot_words().unwrap();
        let restored = Mode::restore_words(&record).unwrap();
        assert_eq!(mode, restored);
        assert_eq!(
            mode.input.requested_rate_m_s.to_bits(),
            restored.input.requested_rate_m_s.to_bits()
        );
        assert_eq!(
            mode.input.motive_power_w.to_bits(),
            restored.input.motive_power_w.to_bits()
        );
        assert_eq!(
            mode.input.holding_power_w.to_bits(),
            restored.input.holding_power_w.to_bits()
        );
        assert_eq!(record, restored.snapshot_words().unwrap());
        let hold = Mode::new(
            Input {
                requested_rate_m_s: -0.,
                motive_power_w: 0.,
                holding_power_w: 20.,
            },
            1,
        )
        .unwrap();
        assert_eq!(
            Mode::restore_words(&hold.snapshot_words().unwrap())
                .unwrap()
                .input
                .requested_rate_m_s
                .to_bits(),
            (-0f64).to_bits()
        );
    }
    #[test]
    fn malformed_mode_records_refuse_shape_input_enum_boolean_and_trailing_fields() {
        let mode = Mode::new(
            Input {
                requested_rate_m_s: 0.008,
                motive_power_w: 1000.,
                holding_power_w: 20.,
            },
            1,
        )
        .unwrap();
        let record = mode.snapshot_words().unwrap();
        let words = record
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for (at, bad) in [
            (0, "OTHER_MODE"),
            (1, "0"),
            (1, "2"),
            (1, "18446744073709551615"),
            (1, "1.0"),
            (2, "NaN"),
            (2, "infinity"),
            (3, "-1"),
            (3, "0"),
            (4, "0"),
            (5, "unknown-regulator"),
            (6, "unknown-joint"),
            (7, "true"),
            (8, "2"),
            (9, "-1"),
        ] {
            let mut bad_words = words.clone();
            bad_words[at] = bad.into();
            assert!(
                Mode::restore_words(&bad_words.join(" ")).is_err(),
                "field {at} accepted {bad}"
            );
        }
        assert!(Mode::restore_words("").is_err());
        assert!(Mode::restore_words(&words[..9].join(" ")).is_err());
        assert!(Mode::restore_words(&(record + " extra")).is_err());
        let mut malformed = mode.clone();
        malformed.geometry.clear();
        assert!(malformed.snapshot_words().is_err());
        malformed.branches.clear();
        assert!(malformed.snapshot_words().is_err());
        malformed = mode;
        malformed.input.holding_power_w = f64::INFINITY;
        assert!(malformed.snapshot_words().is_err());
    }
    #[test]
    fn branch_independent_relative_chart_round_trips_and_preserves_other_owners() {
        let layout = Layout {
            cooling_end: 17,
            mechanics_start: 17,
            fluid_mechanical_work: 33,
            dimension: 34,
        };
        let chart = MechanicalCoordinates {
            layout,
            clusters: 2,
        };
        let physical = (0..34).map(|i| i as f64 * 0.125).collect::<Vec<_>>();
        let mut encoded = physical.clone();
        chart.to_solver(&mut encoded).unwrap();
        assert_eq!(&encoded[..17], &physical[..17]);
        assert_eq!(encoded[33], physical[33]);
        for k in 0..2 {
            let r = 17 + k * WIDTH;
            assert_eq!(
                encoded[r + BODY_Y],
                physical[r + BODY_Y] - physical[r + STEM_Y]
            );
            assert_eq!(
                encoded[r + BODY_V],
                physical[r + BODY_V] - physical[r + STEM_V]
            );
        }
        chart.to_physical(&mut encoded).unwrap();
        assert_eq!(
            encoded.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            physical.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        assert!(chart.to_solver(&mut encoded[..33]).is_err());
    }
    #[test]
    fn actual_contact_value_and_tangent_have_exact_zero_relative_rhs() {
        let c = am::Config {
            body_mass_kg: 70.,
            stem_mass_kg: 10.,
            force_limit_n: 2000.,
            grip_closed_force_n: 2000.,
            gap_stroke_m: 0.01,
            maximum_rate_m_s: 0.008,
            efficiency: 0.8,
            joint_capacity_n: 2500.,
        };
        let s = am::State {
            body_y_m: 0.03,
            body_v_m_s: 0.004,
            stem_y_m: 0.03,
            stem_v_m_s: 0.004,
            reference_y_m: 0.04,
        };
        let i = am::Input {
            requested_rate_m_s: 0.008,
            motive_power_w: 1000. / 52.,
            holding_power_w: 20. / 52.,
            gap_m: 0.,
        };
        let f = am::Forces {
            body_n: -600.,
            stem_n: -80.,
        };
        let b = am::TrialBranch {
            regulator: am::RegulatorBranch::ApproachPositive,
            joint: am::JointMode::Contact,
        };
        let q = c.evaluate_trial(s, i, f, b).unwrap();
        assert_eq!(
            q.body_acceleration_m_s2.to_bits(),
            q.stem_acceleration_m_s2.to_bits()
        );
        let ds = am::State {
            body_y_m: 0.1,
            body_v_m_s: 0.001,
            stem_y_m: 0.2,
            stem_v_m_s: -0.002,
            reference_y_m: 0.3,
        };
        let dq = c
            .evaluate_trial_direction(
                s,
                i,
                f,
                b,
                ds,
                am::Forces {
                    body_n: 0.7,
                    stem_n: -0.3,
                },
            )
            .unwrap();
        assert_eq!(
            dq.body_acceleration_m_s2.to_bits(),
            dq.stem_acceleration_m_s2.to_bits()
        );
        let chart = MechanicalCoordinates {
            layout: Layout {
                cooling_end: 0,
                mechanics_start: 0,
                fluid_mechanical_work: WIDTH,
                dimension: WIDTH + 1,
            },
            clusters: 1,
        };
        let mut rates = vec![
            s.body_v_m_s,
            q.body_acceleration_m_s2,
            s.stem_v_m_s,
            q.stem_acceleration_m_s2,
            q.reference_rate_m_s,
            1.,
            0.,
            0.,
            0.,
        ];
        chart.to_solver(&mut rates).unwrap();
        assert_eq!(rates[BODY_Y], 0.);
        assert_eq!(rates[BODY_V], 0.);
    }
    #[test]
    fn relative_preconditioner_solves_contact_invariants_and_the_actual_work_row() {
        let cj = 3.;
        let mut block = [[0.; WIDTH]; WIDTH];
        for j in 0..WIDTH {
            block[j][j] = cj;
        }
        block[BODY_Y][BODY_V] = -1.;
        block[STEM_Y][STEM_V] = -1.;
        let work = vec![0.2, -0.3, 1.1, 0.7, 0., 0., 0., 0.];
        let mut p = MechanicalPreconditioner {
            blocks: vec![block],
            pivots: vec![[0, 1, 2, 3, 4, 5, 6, 7]],
            work_row: work.clone(),
            work_diagonal: cj,
            contact: vec![true],
            scratch: vec![0.; WIDTH + 1],
            valid: true,
            owner: Arc::new(()),
        };
        for relative in [0., 0.017] {
            let rhs = vec![
                relative, -relative, 0.31, -0.29, 0.23, 0.17, -0.11, 0.07, 0.19,
            ];
            let mut out = vec![0.; rhs.len()];
            p.solve_solver(&rhs, &mut out).unwrap();
            assert_eq!(out[BODY_V], rhs[BODY_V] / cj);
            assert_eq!(out[BODY_Y], (rhs[BODY_Y] + out[BODY_V]) / cj);
            if relative == 0. {
                assert_eq!(out[BODY_Y], 0.);
                assert_eq!(out[BODY_V], 0.);
            }
            out[BODY_Y] += out[STEM_Y];
            out[BODY_V] += out[STEM_V];
            let actual = work
                .iter()
                .zip(&out[..WIDTH])
                .map(|(a, x)| a * x)
                .sum::<f64>()
                + cj * out[WIDTH];
            assert!((actual - rhs[WIDTH]).abs() < 1e-15);
        }
    }
    #[test]
    fn downstream_reference_and_heat_cannot_seed_rest_or_tracking_velocity() {
        for (cj, reference_velocity, heat_velocity, downstream_row, load) in [
            (3., 0., 385.4723, JACK_HEAT, 0.3),
            (0.3, -1., 0., REFERENCE_Y, 0.1),
        ] {
            let mut block = [[0.; WIDTH]; WIDTH];
            for j in 0..WIDTH {
                block[j][j] = cj;
            }
            block[BODY_Y][BODY_V] = -1.;
            block[STEM_Y][STEM_V] = -1.;
            block[REFERENCE_Y][STEM_V] = reference_velocity;
            block[JACK_HEAT][STEM_V] = heat_velocity;
            let mut p = MechanicalPreconditioner {
                blocks: vec![block],
                pivots: vec![[0; WIDTH]],
                work_row: vec![0.; WIDTH],
                work_diagonal: cj,
                contact: vec![true],
                scratch: vec![0.; WIDTH + 1],
                valid: false,
                owner: Arc::new(()),
            };
            p.factor().unwrap();
            let mut rhs = vec![0.; WIDTH + 1];
            rhs[downstream_row] = load;
            let mut out = vec![0.; WIDTH + 1];
            p.solve_solver(&rhs, &mut out).unwrap();
            assert_eq!(out[STEM_V], 0.,
                "Downstream row {downstream_row} seeded a false finite velocity at cj={cj}: {:e}",
                out[STEM_V]);
            assert_eq!(out[STEM_Y], 0.);
            assert_eq!(out[BODY_V], 0.);
            assert_eq!(out[BODY_Y], 0.);
            assert_eq!(out[downstream_row], load / cj);
        }
    }
    #[test]
    fn triangular_preconditioner_satisfies_mechanics_reference_heat_and_work_rows() {
        for (contact, cj) in [false, true].into_iter()
            .flat_map(|contact| [0.03, 3., 300.].map(|cj| (contact, cj)))
        {
            let mut block = [[0.; WIDTH]; WIDTH];
            for j in 0..WIDTH {
                block[j][j] = cj;
            }
            block[BODY_Y][BODY_V] = -1.;
            block[BODY_V][BODY_Y] = 2.3;
            block[BODY_V][BODY_V] += 4.7;
            block[BODY_V][STEM_Y] = -0.2;
            block[BODY_V][STEM_V] = 0.5;
            block[STEM_Y][STEM_V] = -1.;
            block[STEM_V][BODY_Y] = 0.7;
            block[STEM_V][BODY_V] = -0.3;
            block[STEM_V][STEM_Y] = 1.2;
            block[STEM_V][STEM_V] += 5.3;
            if contact {
                // Contact has one common acceleration gradient, with only
                // the two independent cj velocity diagonals differing.
                // Consequently its relative velocity row is exactly cj,
                // even with nonzero position and velocity force coupling.
                block[STEM_V] = block[BODY_V];
                block[STEM_V][BODY_V] -= cj;
                block[STEM_V][STEM_V] += cj;
            }
            block[REFERENCE_Y][STEM_V] = -1.;
            for row in JACK_HEAT..WIDTH {
                for col in 0..REFERENCE_Y {
                    block[row][col] = ((row + 1) * (col + 1)) as f64 * 13.7;
                }
            }
            let original = block;
            let work = if contact {
                // The actual fluid work port depends on finite mechanics,
                // not massless reference position or caloric stocks.
                vec![0.2, -0.3, 1.1, 0.7, 0., 0., 0., 0.]
            } else {
                vec![0.2, -0.3, 1.1, 0.7, 0.1, -0.2, 0.3, -0.4]
            };
            let mut p = MechanicalPreconditioner {
                blocks: vec![block],
                pivots: vec![[0; WIDTH]],
                work_row: work.clone(),
                work_diagonal: cj,
                contact: vec![contact],
                scratch: vec![0.; WIDTH + 1],
                valid: false,
                owner: Arc::new(()),
            };
            p.factor().unwrap();
            for rhs in [
                vec![0.3, -0.7, 0.1, 1.3, -0.9, 0.4, 0.5, -0.6, 0.2],
                vec![0., 0., 0., 0., 0.2, 0.3, -0.4, 0.5, -0.6],
            ] {
                for solver_chart in [false, true] {
                    let mut out = vec![0.; WIDTH + 1];
                    if solver_chart {
                        let mut encoded = rhs.clone();
                        encoded[BODY_Y] -= encoded[STEM_Y];
                        encoded[BODY_V] -= encoded[STEM_V];
                        p.solve_solver(&encoded, &mut out).unwrap();
                        if contact {
                            assert_eq!(out[BODY_V], encoded[BODY_V] / cj);
                            assert_eq!(out[BODY_Y], (encoded[BODY_Y] + out[BODY_V]) / cj);
                        }
                        out[BODY_Y] += out[STEM_Y];
                        out[BODY_V] += out[STEM_V];
                    } else {
                        p.solve(&rhs, &mut out).unwrap();
                    }
                    for row in 0..WIDTH {
                        let actual = original[row].iter().zip(&out)
                            .map(|(a, x)| a * x).sum::<f64>();
                        assert!((actual - rhs[row]).abs() < 1e-10,
                            "P row {row} defect at cj={cj}, contact={contact}, solver_chart={solver_chart}: {:e}",
                            actual - rhs[row]);
                    }
                    let actual_work = work.iter().zip(&out).map(|(a, x)| a * x)
                        .sum::<f64>() + cj * out[WIDTH];
                    assert!((actual_work - rhs[WIDTH]).abs() < 1e-10,
                        "P work defect at cj={cj}, contact={contact}, solver_chart={solver_chart}: {:e}",
                        actual_work - rhs[WIDTH]);
                }
            }
        }
    }
    #[test]
    fn triangular_preconditioner_refuses_new_downstream_feedback() {
        for (row, col) in [
            (BODY_V, REFERENCE_Y),
            (STEM_V, JACK_HEAT),
            (JACK_HEAT, STEM_HEAT),
            (REFERENCE_Y, SPIDER_HEAT),
        ] {
            let mut block = [[0.; WIDTH]; WIDTH];
            for j in 0..WIDTH {
                block[j][j] = 3.;
            }
            block[row][col] = 0.1;
            let mut p = MechanicalPreconditioner {
                blocks: vec![block],
                pivots: vec![[0; WIDTH]],
                work_row: vec![0.; WIDTH],
                work_diagonal: 3.,
                contact: vec![false],
                scratch: vec![0.; WIDTH + 1],
                valid: false,
                owner: Arc::new(()),
            };
            assert!(p.factor().unwrap_err().contains("unowned reference/caloric feedback"));
            assert!(!p.valid);
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeometryBranch {
    pub body_right: bool,
    pub stem_right: bool,
    pub seated: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Mode {
    pub input: Input,
    pub branches: Vec<am::TrialBranch>,
    pub geometry: Vec<GeometryBranch>,
}
impl Mode {
    pub fn new(input: Input, clusters: usize) -> Result<Self, String> {
        validate_input(input)?;
        if clusters == 0 {
            return Err("Empty connected mechanical bank".into());
        }
        let regulator = if input.requested_rate_m_s > 0. {
            am::RegulatorBranch::ApproachPositive
        } else if input.requested_rate_m_s < 0. {
            am::RegulatorBranch::ApproachNegative
        } else {
            am::RegulatorBranch::HoldRest
        };
        Ok(Self {
            input,
            branches: vec![
                am::TrialBranch {
                    regulator,
                    joint: am::JointMode::Contact
                };
                clusters
            ],
            // The ordinary lifting branch is the explicit off-seat limit of
            // the same ORIGINAL pose, not a synthetic finite displacement.
            geometry: vec![
                GeometryBranch {
                    body_right: true,
                    stem_right: true,
                    seated: false
                };
                clusters
            ],
        })
    }
    /// Complete discrete continuation paired with the caller's retained
    /// physical state/support checkpoint. The record owns no second clock.
    pub fn snapshot_words(&self) -> Result<String, String> {
        validate_input(self.input)?;
        if self.branches.is_empty() || self.branches.len() != self.geometry.len() {
            return Err("Invalid retained mechanical mode shape".into());
        }
        let mut out = format!(
            "SOURCE_MOTION_MODE {} {:.17e} {:.17e} {:.17e}\n",
            self.branches.len(),
            self.input.requested_rate_m_s,
            self.input.motive_power_w,
            self.input.holding_power_w
        );
        for (b, g) in self.branches.iter().zip(&self.geometry) {
            let regulator = match b.regulator {
                am::RegulatorBranch::ApproachPositive => "approach-positive",
                am::RegulatorBranch::ApproachNegative => "approach-negative",
                am::RegulatorBranch::Track => "track",
                am::RegulatorBranch::HoldPositive => "hold-positive",
                am::RegulatorBranch::HoldNegative => "hold-negative",
                am::RegulatorBranch::HoldRest => "hold-rest",
                am::RegulatorBranch::Open => "open",
            };
            let joint = match b.joint {
                am::JointMode::Contact => "contact",
                am::JointMode::Separated => "separated",
            };
            out.push_str(&format!(
                "{regulator} {joint} {} {} {}\n",
                u8::from(g.body_right),
                u8::from(g.stem_right),
                u8::from(g.seated)
            ));
        }
        Ok(out)
    }
    pub fn restore_words(record: &str) -> Result<Self, String> {
        let words = record.split_whitespace().collect::<Vec<_>>();
        if words.len() < 5 || words[0] != "SOURCE_MOTION_MODE" {
            return Err("Invalid retained mechanical mode frame".into());
        }
        let count = words[1]
            .parse::<usize>()
            .map_err(|_| "Invalid retained mechanical cluster count")?;
        let expected = count
            .checked_mul(5)
            .and_then(|n| n.checked_add(5))
            .ok_or("Retained mechanical mode size overflow")?;
        if count == 0 || words.len() != expected {
            return Err("Wrong retained mechanical mode field count".into());
        }
        let number = |word: &str| {
            word.parse::<f64>()
                .map_err(|_| String::from("Invalid retained mechanical input"))
        };
        let input = Input {
            requested_rate_m_s: number(words[2])?,
            motive_power_w: number(words[3])?,
            holding_power_w: number(words[4])?,
        };
        validate_input(input)?;
        let boolean = |word: &str| match word {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(String::from("Invalid retained mechanical geometry boolean")),
        };
        let mut branches = Vec::with_capacity(count);
        let mut geometry = Vec::with_capacity(count);
        for row in words[5..].chunks_exact(5) {
            let regulator = match row[0] {
                "approach-positive" => am::RegulatorBranch::ApproachPositive,
                "approach-negative" => am::RegulatorBranch::ApproachNegative,
                "track" => am::RegulatorBranch::Track,
                "hold-positive" => am::RegulatorBranch::HoldPositive,
                "hold-negative" => am::RegulatorBranch::HoldNegative,
                "hold-rest" => am::RegulatorBranch::HoldRest,
                "open" => am::RegulatorBranch::Open,
                _ => return Err("Invalid retained mechanical regulator branch".into()),
            };
            let joint = match row[1] {
                "contact" => am::JointMode::Contact,
                "separated" => am::JointMode::Separated,
                _ => return Err("Invalid retained mechanical joint branch".into()),
            };
            branches.push(am::TrialBranch { regulator, joint });
            geometry.push(GeometryBranch {
                body_right: boolean(row[2])?,
                stem_right: boolean(row[3])?,
                seated: boolean(row[4])?,
            });
        }
        Ok(Self {
            input,
            branches,
            geometry,
        })
    }
}
fn validate_input(i: Input) -> Result<(), String> {
    if [i.requested_rate_m_s, i.motive_power_w, i.holding_power_w]
        .iter()
        .any(|v| !v.is_finite())
        || i.motive_power_w < 0.
        || i.holding_power_w <= 0.
        || (i.requested_rate_m_s == 0. && i.motive_power_w != 0.)
        || (i.requested_rate_m_s != 0. && i.motive_power_w == 0.)
    {
        return Err("Ordinary connected motion lacks actual delivered support".into());
    }
    Ok(())
}
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub cooling_end: usize,
    pub mechanics_start: usize,
    pub fluid_mechanical_work: usize,
    pub dimension: usize,
}
/// Branch-independent linear numerical coordinates. The first body pair is
/// its displacement/velocity relative to the retained stem; every physical
/// body/stem/reference/heat owner is still reconstructed separately. Exact
/// common contact accelerations then give an exactly zero relative RHS.
pub struct MechanicalCoordinates {
    layout: Layout,
    clusters: usize,
}
impl MechanicalCoordinates {
    pub fn new(model: &Model) -> Self {
        Self {
            layout: model.layout,
            clusters: model.clusters(),
        }
    }
    /// The same linear map applies to states, rates, residuals, directions and
    /// corrections. It leaves the complete cooling prefix and work receipt.
    pub fn to_solver(&self, values: &mut [f64]) -> Result<(), String> {
        if values.len() != self.layout.dimension {
            return Err("Wrong mechanical coordinate vector".into());
        }
        for k in 0..self.clusters {
            let r = self.layout.mechanics_start + k * WIDTH;
            values[r + BODY_Y] -= values[r + STEM_Y];
            values[r + BODY_V] -= values[r + STEM_V];
        }
        Ok(())
    }
    pub fn to_physical(&self, values: &mut [f64]) -> Result<(), String> {
        if values.len() != self.layout.dimension {
            return Err("Wrong mechanical coordinate vector".into());
        }
        for k in 0..self.clusters {
            let r = self.layout.mechanics_start + k * WIDTH;
            values[r + BODY_Y] += values[r + STEM_Y];
            values[r + BODY_V] += values[r + STEM_V];
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct RootAccuracy {
    pub position_m: f64,
    pub velocity_m_s: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct EventReport {
    pub velocity_events: usize,
    pub contact_events: usize,
    pub separation_events: usize,
    pub contact_heat_j: f64,
    /// Signed representational KE/PE adjustment at a resolved root, retained
    /// separately from real impact heat. It is never paid as physical heat.
    pub mechanical_adjustment_j: f64,
    pub maximum_position_adjustment_m: f64,
    pub maximum_velocity_adjustment_m_s: f64,
    pub needs_fluid_initialization: bool,
}
pub struct Model {
    pub cooling: sc::Model,
    pub geometry: cg::Prepared,
    pub hydraulics: cf::Plan,
    config: Vec<am::Config>,
    pub layout: Layout,
    owner: Arc<()>,
}
pub struct Workspace {
    pub cooling: sc::Workspace,
    pub geometry: cg::Workspace,
    pub fluid: cf::Workspace,
    pub water: Vec<on::WaterShape>,
    pub dwater: Vec<on::WaterShape>,
    pub connections: Vec<on::MovingConnection>,
    pub dconnections: Vec<on::MovingConnectionDirection>,
    pub forces: Vec<am::Forces>,
    pub responses: Vec<am::Response>,
    pub residual: Vec<f64>,
    pub jvp: Vec<f64>,
    pub rates: Vec<f64>,
    poses: Vec<cg::Pose>,
    dposes: Vec<cg::Direction>,
    velocity: Vec<cg::Direction>,
    dvelocity: Vec<cg::Direction>,
    dforces: Vec<am::Forces>,
    state: Vec<f64>,
    mode: Option<Mode>,
    cj: Option<f64>,
    owner: Arc<()>,
    valid: bool,
    energy_rate: f64,
    energy_tangent: Option<f64>,
    thermal_work_rate: f64,
    thermal_work_tangent: Option<f64>,
}
/// Root interpolation prepares only actual geometry, fluid properties and
/// traction. Its separate owned workspace cannot replace an implicit stage's
/// prepared SOURCE/heat Jacobian, and has no separate state or time owner.
pub struct RootWorkspace {
    pub network: on::Workspace,
    geometry: cg::Workspace,
    fluid: cf::Workspace,
    water: Vec<on::WaterShape>,
    connections: Vec<on::MovingConnection>,
    poses: Vec<cg::Pose>,
    velocity: Vec<cg::Direction>,
    zero: Vec<cg::Direction>,
    responses: Vec<am::Response>,
    owner: Arc<()>,
}
/// Held-fluid component blocks with their physical triangular ownership:
/// four finite body/stem coordinates, then the massless reference and three
/// caloric coordinates, then the signed work receipt. Downstream reference or
/// heat rows cannot pivot into a finite zero-acceleration equation. This never
/// approximates the actual residual or JVP and owns no integration clock.
pub struct MechanicalPreconditioner {
    blocks: Vec<[[f64; WIDTH]; WIDTH]>,
    pivots: Vec<[usize; WIDTH]>,
    work_row: Vec<f64>,
    work_diagonal: f64,
    contact: Vec<bool>,
    scratch: Vec<f64>,
    valid: bool,
    owner: Arc<()>,
}
impl MechanicalPreconditioner {
    pub fn new(model: &Model) -> Self {
        Self {
            blocks: vec![[[0.; WIDTH]; WIDTH]; model.clusters()],
            pivots: vec![[0; WIDTH]; model.clusters()],
            work_row: vec![0.; WIDTH * model.clusters()],
            work_diagonal: 0.,
            contact: vec![false; model.clusters()],
            scratch: vec![0.; WIDTH * model.clusters() + 1],
            valid: false,
            owner: model.owner.clone(),
        }
    }
    pub fn setup(&mut self, model: &Model, w: &Workspace, cj: f64) -> Result<(), String> {
        self.valid = false;
        if !Arc::ptr_eq(&self.owner, &model.owner)
            || self.blocks.len() != model.clusters()
            || !cj.is_finite()
            || cj <= 0.
        {
            return Err("Invalid small mechanical P stage".into());
        }
        self.blocks.fill([[0.; WIDTH]; WIDTH]);
        self.work_row.fill(0.);
        self.work_diagonal = 0.;
        for (c, b) in self
            .contact
            .iter_mut()
            .zip(&w.mode.as_ref().ok_or("Missing mechanical P mode")?.branches)
        {
            *c = b.joint == am::JointMode::Contact;
        }
        let start = model.layout.mechanics_start;
        model.visit_mechanical_jacobian(w, cj, |r, c, v| {
            if r == model.layout.fluid_mechanical_work {
                if c == r {
                    self.work_diagonal += v;
                } else {
                    self.work_row[c - start] += v;
                }
            } else {
                self.blocks[(r - start) / WIDTH][(r - start) % WIDTH][(c - start) % WIDTH] += v;
            }
        })?;
        self.factor()
    }
    fn factor(&mut self) -> Result<(), String> {
        self.valid = false;
        for (a, p) in self.blocks.iter_mut().zip(&mut self.pivots) {
            if a[..REFERENCE_Y]
                .iter()
                .any(|row| row[REFERENCE_Y..].iter().any(|v| *v != 0.))
                || (REFERENCE_Y..WIDTH).any(|row| {
                    a[row][row] != self.work_diagonal
                        || (REFERENCE_Y..WIDTH).any(|col| col != row && a[row][col] != 0.)
                })
            {
                return Err("Mechanical P has an unowned reference/caloric feedback".into());
            }
            // Reference position and apparatus heats never act back on the
            // finite mechanics. Keep their unmodified coupling rows below
            // the four-coordinate factor, even when a heat coefficient is
            // larger than cj. A full 8x8 pivot would recover a zero finite
            // velocity by cancellation against an unrelated heat RHS.
            for k in 0..REFERENCE_Y {
                let pivot = (k..REFERENCE_Y)
                    .max_by(|&i, &j| a[i][k].abs().total_cmp(&a[j][k].abs()))
                    .unwrap();
                p[k] = pivot;
                a.swap(k, pivot);
                if !a[k][k].is_finite() || a[k][k] == 0. {
                    return Err("Singular held-fluid mechanical P".into());
                }
                for i in k + 1..REFERENCE_Y {
                    a[i][k] /= a[k][k];
                    for j in k + 1..REFERENCE_Y {
                        a[i][j] -= a[i][k] * a[k][j];
                    }
                }
            }
        }
        if self
            .blocks
            .iter()
            .flatten()
            .flatten()
            .any(|v| !v.is_finite())
            || !self.work_diagonal.is_finite()
            || self.work_diagonal == 0.
        {
            return Err("Nonfinite/singular mechanical P factors".into());
        }
        self.valid = true;
        Ok(())
    }
    /// Suffix coordinates only, in the model's declared mechanics/work order.
    pub fn solve(&self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        if !self.valid
            || rhs.len() != self.work_row.len() + 1
            || out.len() != rhs.len()
            || rhs.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid mechanical P solve".into());
        }
        for (k, (a, p)) in self.blocks.iter().zip(&self.pivots).enumerate() {
            let x = &mut out[k * WIDTH..(k + 1) * WIDTH];
            x.copy_from_slice(&rhs[k * WIDTH..(k + 1) * WIDTH]);
            for i in 0..REFERENCE_Y {
                x.swap(i, p[i]);
            }
            for i in 0..REFERENCE_Y {
                for j in 0..i {
                    x[i] -= a[i][j] * x[j];
                }
            }
            for i in (0..REFERENCE_Y).rev() {
                for j in i + 1..REFERENCE_Y {
                    x[i] -= a[i][j] * x[j];
                }
                x[i] /= a[i][i];
            }
            for i in REFERENCE_Y..WIDTH {
                x[i] = (rhs[k * WIDTH + i]
                    - (0..REFERENCE_Y).map(|j| a[i][j] * x[j]).sum::<f64>())
                    / a[i][i];
            }
        }
        let end = self.work_row.len();
        out[end] = (rhs[end]
            - self
                .work_row
                .iter()
                .zip(&out[..end])
                .map(|(a, x)| a * x)
                .sum::<f64>())
            / self.work_diagonal;
        if out.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite mechanical P solution".into());
        }
        Ok(())
    }
    /// Same approximate block in the branch-independent relative chart. The
    /// exact independent contact rows are solved directly; a roundoff-sized
    /// difference of two LU outputs cannot seed spurious relative motion.
    /// The signed work row consumes the resulting actual correction.
    pub fn solve_solver(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        if rhs.len() != self.scratch.len() {
            return Err("Wrong relative mechanical P RHS".into());
        }
        self.scratch.copy_from_slice(rhs);
        for k in 0..self.blocks.len() {
            let r = k * WIDTH;
            self.scratch[r + BODY_Y] += self.scratch[r + STEM_Y];
            self.scratch[r + BODY_V] += self.scratch[r + STEM_V];
        }
        self.solve(&self.scratch, out)?;
        for k in 0..self.blocks.len() {
            let r = k * WIDTH;
            out[r + BODY_Y] -= out[r + STEM_Y];
            out[r + BODY_V] -= out[r + STEM_V];
            if self.contact[k] {
                out[r + BODY_V] = rhs[r + BODY_V] / self.work_diagonal;
                out[r + BODY_Y] = (rhs[r + BODY_Y] + out[r + BODY_V]) / self.work_diagonal;
            }
            // Complete the downstream equations with the actual finite
            // correction after the exact relative-contact rows, not with a
            // rounded difference of the two physical LU outputs.
            let a = &self.blocks[k];
            for i in REFERENCE_Y..WIDTH {
                let coupled = (0..REFERENCE_Y)
                    .map(|j| {
                        let x = match j {
                            BODY_Y => out[r + BODY_Y] + out[r + STEM_Y],
                            BODY_V => out[r + BODY_V] + out[r + STEM_V],
                            _ => out[r + j],
                        };
                        a[i][j] * x
                    })
                    .sum::<f64>();
                out[r + i] = (rhs[r + i] - coupled) / a[i][i];
            }
        }
        let mut work = 0.;
        for k in 0..self.blocks.len() {
            let r = k * WIDTH;
            for j in 0..WIDTH {
                let x = match j {
                    BODY_Y => out[r + BODY_Y] + out[r + STEM_Y],
                    BODY_V => out[r + BODY_V] + out[r + STEM_V],
                    _ => out[r + j],
                };
                work += self.work_row[r + j] * x;
            }
        }
        let end = self.work_row.len();
        out[end] = (rhs[end] - work) / self.work_diagonal;
        if out.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite relative mechanical P solution".into());
        }
        Ok(())
    }
}
impl Workspace {
    pub fn current_geometry(&self) -> sc::CurrentGeometry<'_> {
        sc::CurrentGeometry {
            source: &self.geometry.value.source,
            contacts: &self.geometry.value.contacts,
            mobile: &self.geometry.value.mobile,
            barrel_chords_m: &self.geometry.value.barrel_chords_m,
            network: on::MotionGeometry {
                water: &self.water,
                connections: &self.connections,
            },
        }
    }
    pub fn geometry_direction(&self) -> sc::GeometryDirection<'_> {
        sc::GeometryDirection {
            source: &self.geometry.direction.source,
            contacts: &self.geometry.direction.contacts,
            mobile: &self.geometry.direction.mobile,
            barrel_chords_m: &self.geometry.direction.barrel_chords_m,
            water: &self.dwater,
            connections: &self.dconnections,
        }
    }
    pub fn complete_energy_rate(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current connected mechanical energy stage".into());
        }
        Ok(self.energy_rate)
    }
    pub fn complete_energy_rate_jvp(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current connected mechanical energy stage".into());
        }
        self.energy_tangent
            .ok_or("No current connected mechanical energy tangent".into())
    }
    /// Affine cooling-energy plus signed fluid/mechanics work rate, assembled
    /// before nonlinear KE/PE balance or a time-discretization shift.
    pub fn thermal_work_energy_rate(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current thermal/work energy stage".into());
        }
        Ok(self.thermal_work_rate)
    }
    pub fn thermal_work_energy_rate_jvp(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current thermal/work energy stage".into());
        }
        self.thermal_work_tangent
            .ok_or("No current thermal/work energy tangent".into())
    }
}
fn state(a: &[f64]) -> am::State {
    am::State {
        body_y_m: a[BODY_Y],
        body_v_m_s: a[BODY_V],
        stem_y_m: a[STEM_Y],
        stem_v_m_s: a[STEM_V],
        reference_y_m: a[REFERENCE_Y],
    }
}
fn write_state(a: &mut [f64], s: am::State) {
    a[BODY_Y] = s.body_y_m;
    a[BODY_V] = s.body_v_m_s;
    a[STEM_Y] = s.stem_y_m;
    a[STEM_V] = s.stem_v_m_s;
    a[REFERENCE_Y] = s.reference_y_m;
}
impl Model {
    pub fn new(
        cooling: sc::Model,
        geometry: cg::Prepared,
        hydraulics: cf::Plan,
        config: Vec<am::Config>,
    ) -> Result<Self, String> {
        if config.is_empty()
            || config.len() != geometry.input().clusters
            || geometry.input().water.len() != cooling.network.config().water.len()
        {
            return Err("Connected mechanical geometry/owner count mismatch".into());
        }
        for c in &config {
            c.validate()?;
        }
        hydraulics.check(&cooling.network, config.len())?;
        for b in &hydraulics.bindings {
            if geometry.input().guides[b.cluster] != b.cell {
                return Err("Mechanical force and SOURCE guide owners differ".into());
            }
        }
        let end = cooling.dimension();
        let work = end
            .checked_add(
                WIDTH
                    .checked_mul(config.len())
                    .ok_or("Motion layout overflow")?,
            )
            .ok_or("Motion layout overflow")?;
        Ok(Self {
            cooling,
            geometry,
            hydraulics,
            config,
            layout: Layout {
                cooling_end: end,
                mechanics_start: end,
                fluid_mechanical_work: work,
                dimension: work + 1,
            },
            owner: Arc::new(()),
        })
    }
    pub fn dimension(&self) -> usize {
        self.layout.dimension
    }
    pub fn mechanical_to_solver(&self, values: &mut [f64]) {
        MechanicalCoordinates::new(self)
            .to_solver(values)
            .expect("Validated mechanical solver vector");
    }
    pub fn mechanical_to_physical(&self, values: &mut [f64]) {
        MechanicalCoordinates::new(self)
            .to_physical(values)
            .expect("Validated mechanical solver vector");
    }
    pub fn clusters(&self) -> usize {
        self.config.len()
    }
    pub fn configs(&self) -> &[am::Config] {
        &self.config
    }
    pub fn motion_row(&self, cluster: usize, field: usize) -> usize {
        self.layout.mechanics_start + WIDTH * cluster + field
    }
    pub fn is_differential(&self, row: usize) -> bool {
        if row < self.layout.cooling_end {
            self.cooling.is_differential(row)
        } else {
            row < self.dimension()
        }
    }
    pub fn root_count(&self) -> usize {
        ROOTS_PER_CLUSTER * self.clusters()
    }
    pub fn initial_state(&self, input: Option<crate::prhr::Input>) -> Result<Vec<f64>, String> {
        let mut y = self.cooling.initial_state_with_prhr_input(input)?;
        y.resize(self.dimension(), 0.);
        Ok(y)
    }
    pub fn workspace(&self) -> Workspace {
        let n = self.clusters();
        let nw = self.geometry.input().water.len();
        let zero = cg::Direction { body: 0., stem: 0. };
        Workspace {
            cooling: self.cooling.workspace(),
            geometry: self.geometry.workspace(),
            fluid: cf::Workspace::new(&self.hydraulics),
            water: vec![on::WaterShape::default(); nw],
            dwater: vec![on::WaterShape::default(); nw],
            connections: Vec::with_capacity(2 * n),
            dconnections: Vec::with_capacity(2 * n),
            forces: vec![
                am::Forces {
                    body_n: 0.,
                    stem_n: 0.
                };
                n
            ],
            responses: Vec::with_capacity(n),
            residual: vec![0.; self.dimension()],
            jvp: vec![0.; self.dimension()],
            rates: vec![0.; self.dimension()],
            poses: vec![
                cg::Pose {
                    body: 0.,
                    stem: 0.,
                    body_right: true,
                    stem_right: true,
                    seated: false
                };
                n
            ],
            dposes: vec![zero; n],
            velocity: vec![zero; n],
            dvelocity: vec![zero; n],
            dforces: vec![
                am::Forces {
                    body_n: 0.,
                    stem_n: 0.
                };
                n
            ],
            state: vec![0.; self.dimension()],
            mode: None,
            cj: None,
            owner: self.owner.clone(),
            valid: false,
            energy_rate: f64::NAN,
            energy_tangent: None,
            thermal_work_rate: f64::NAN,
            thermal_work_tangent: None,
        }
    }
    pub fn root_workspace(&self) -> RootWorkspace {
        let n = self.clusters();
        RootWorkspace {
            network: on::Workspace::new(&self.cooling.network),
            geometry: self.geometry.workspace(),
            fluid: cf::Workspace::new(&self.hydraulics),
            water: vec![on::WaterShape::default(); self.geometry.input().water.len()],
            connections: Vec::with_capacity(2 * n),
            poses: vec![
                cg::Pose {
                    body: 0.,
                    stem: 0.,
                    body_right: true,
                    stem_right: true,
                    seated: false
                };
                n
            ],
            velocity: vec![cg::Direction { body: 0., stem: 0. }; n],
            zero: vec![cg::Direction { body: 0., stem: 0. }; n],
            responses: Vec::with_capacity(n),
            owner: self.owner.clone(),
        }
    }
    /// Lightweight root evaluation at the caller's actual interpolated state.
    /// Relative pressure/current and geometry are supplied by this same trial;
    /// forces do not depend on recomputing nuclear/source or thermal receipts.
    pub fn roots_at(
        &self,
        y: &[f64],
        yp: &[f64],
        prhr: Option<crate::prhr::Input>,
        mode: &Mode,
        w: &mut RootWorkspace,
        out: &mut [f64],
    ) -> Result<(), String> {
        validate_input(mode.input)?;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.dimension()
            || yp.len() != y.len()
            || y.iter().chain(yp).any(|v| !v.is_finite())
            || mode.branches.len() != self.clusters()
            || mode.geometry.len() != self.clusters()
        {
            return Err("Invalid lightweight mechanical root stage".into());
        }
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&y[r..r + WIDTH]);
            let b = mode.geometry[k];
            w.poses[k] = cg::Pose {
                body: s.body_y_m,
                stem: s.stem_y_m,
                body_right: b.body_right,
                stem_right: b.stem_right,
                seated: b.seated,
            };
            w.velocity[k] = cg::Direction {
                body: s.body_v_m_s,
                stem: s.stem_v_m_s,
            };
        }
        self.geometry
            .evaluate_into(&w.poses, &w.zero, &mut w.geometry)?;
        self.geometry
            .water_rates_into(&w.velocity, &w.zero, &mut w.geometry)?;
        for j in 0..w.water.len() {
            let v = w.geometry.value.water[j];
            let r = w.geometry.water_rates[j];
            w.water[j] = on::WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            };
        }
        self.hydraulics
            .connections_into(&w.poses, &w.velocity, &mut w.connections)?;
        let l = self.cooling.layout;
        let yn = &y[l.network_start..l.carrier_start];
        // The surge port affects balances, but not this state's EOS chart,
        // current hydraulic response or traction. No fixture force is used.
        w.network.evaluate_with_motion(
            &self.cooling.network,
            yn,
            &yp[l.network_start..l.carrier_start],
            None,
            &[],
            prhr,
            Some(on::MotionGeometry {
                water: &w.water,
                connections: &w.connections,
            }),
        )?;
        self.hydraulics.evaluate(
            &self.cooling.network,
            yn,
            &w.network,
            &w.geometry,
            &w.poses,
            &w.velocity,
            &mut w.fluid,
        )?;
        w.responses.clear();
        let input = self.per_cluster_input(mode.input);
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let c = self.config[k];
            let f = w.fluid.forces[k];
            w.responses.push(c.evaluate_trial(
                state(&y[r..r + WIDTH]),
                input,
                am::Forces {
                    body_n: f.body_n - c.body_mass_kg * GRAVITY,
                    stem_n: f.stem_n - c.stem_mass_kg * GRAVITY,
                },
                mode.branches[k],
            )?);
        }
        self.fill_roots(y, mode, &w.responses, out)
    }
    fn check(&self, y: &[f64], w: &Workspace, mode: &Mode) -> Result<(), String> {
        validate_input(mode.input)?;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.dimension()
            || y.iter().any(|v| !v.is_finite())
            || mode.branches.len() != self.clusters()
            || mode.geometry.len() != self.clusters()
            || self
                .config
                .iter()
                .any(|c| mode.input.requested_rate_m_s.abs() > c.maximum_rate_m_s)
        {
            return Err("Wrong connected mechanical stage/workspace/mode".into());
        }
        Ok(())
    }
    /// Pure candidate geometry preparation. This is deliberately independent
    /// of any previously prepared cooling state, including accepted admission.
    pub fn prepare_geometry(
        &self,
        y: &[f64],
        dy: Option<&[f64]>,
        w: &mut Workspace,
        mode: &Mode,
    ) -> Result<(), String> {
        w.valid = false;
        self.check(y, w, mode)?;
        if dy.is_some_and(|d| d.len() != y.len() || d.iter().any(|v| !v.is_finite())) {
            return Err("Wrong connected geometry direction".into());
        }
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&y[r..r + WIDTH]);
            let b = mode.geometry[k];
            w.poses[k] = cg::Pose {
                body: s.body_y_m,
                stem: s.stem_y_m,
                body_right: b.body_right,
                stem_right: b.stem_right,
                seated: b.seated,
            };
            w.velocity[k] = cg::Direction {
                body: s.body_v_m_s,
                stem: s.stem_v_m_s,
            };
            w.dposes[k] = cg::Direction {
                body: dy.map_or(0., |d| d[r + BODY_Y]),
                stem: dy.map_or(0., |d| d[r + STEM_Y]),
            };
            w.dvelocity[k] = cg::Direction {
                body: dy.map_or(0., |d| d[r + BODY_V]),
                stem: dy.map_or(0., |d| d[r + STEM_V]),
            };
        }
        self.geometry
            .evaluate_into(&w.poses, &w.dposes, &mut w.geometry)?;
        self.geometry
            .water_rates_into(&w.velocity, &w.dvelocity, &mut w.geometry)?;
        for j in 0..w.water.len() {
            let v = w.geometry.value.water[j];
            let r = w.geometry.water_rates[j];
            let dv = w.geometry.direction.water[j];
            let dr = w.geometry.water_rate_direction[j];
            w.water[j] = on::WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            };
            w.dwater[j] = on::WaterShape {
                volume_m3: dv.volume,
                first_moment_m4: dv.moment,
                volume_rate_m3_s: dr.volume,
                first_moment_rate_m4_s: dr.moment,
            };
        }
        self.hydraulics
            .connections_into(&w.poses, &w.velocity, &mut w.connections)?;
        self.hydraulics
            .directions_into(&w.dposes, &w.dvelocity, &mut w.dconnections)?;
        Ok(())
    }
    fn per_cluster_input(&self, input: Input) -> am::Input {
        am::Input {
            requested_rate_m_s: input.requested_rate_m_s,
            motive_power_w: input.motive_power_w / self.clusters() as f64,
            holding_power_w: input.holding_power_w / self.clusters() as f64,
            gap_m: 0.,
        }
    }
    pub fn evaluate(
        &self,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        w: &mut Workspace,
        prhr: Option<crate::prhr::Input>,
        mode: &Mode,
    ) -> Result<(), String> {
        w.valid = false;
        w.energy_tangent = None;
        w.thermal_work_tangent = None;
        if yp.len() != self.dimension() || yp.iter().any(|v| !v.is_finite()) {
            return Err("Wrong connected mechanical derivative".into());
        }
        self.prepare_geometry(y, None, w, mode)?;
        let l = self.cooling.layout;
        let end = self.layout.cooling_end;
        self.cooling.evaluate_with_current_geometry(
            &y[..end],
            &yp[..end],
            cj,
            &mut w.cooling,
            prhr,
            sc::CurrentGeometry {
                source: &w.geometry.value.source,
                contacts: &w.geometry.value.contacts,
                mobile: &w.geometry.value.mobile,
                barrel_chords_m: &w.geometry.value.barrel_chords_m,
                network: on::MotionGeometry {
                    water: &w.water,
                    connections: &w.connections,
                },
            },
        )?;
        self.hydraulics.evaluate(
            &self.cooling.network,
            &y[l.network_start..l.carrier_start],
            &w.cooling.network,
            &w.geometry,
            &w.poses,
            &w.velocity,
            &mut w.fluid,
        )?;
        w.residual[..end].copy_from_slice(&w.cooling.residual);
        let upper_energy = l.network_start + self.cooling.network.energy_row(self.hydraulics.upper);
        w.residual[upper_energy] -= w.fluid.stem_fluid_work_w;
        w.responses.clear();
        let input = self.per_cluster_input(mode.input);
        let mut water_power = 0.;
        let mut mechanical_power = 0.;
        let mut apparatus_heat = 0.;
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&y[r..r + WIDTH]);
            let c = self.config[k];
            let f = w.fluid.forces[k];
            let gravity = am::Forces {
                body_n: f.body_n - c.body_mass_kg * GRAVITY,
                stem_n: f.stem_n - c.stem_mass_kg * GRAVITY,
            };
            w.forces[k] = gravity;
            let q = c.evaluate_trial(s, input, gravity, mode.branches[k])?;
            let heat = q.slip_to_jack_w + q.electrical_loss_to_jack_w + q.holding_to_jack_w;
            let rr = [
                s.body_v_m_s,
                q.body_acceleration_m_s2,
                s.stem_v_m_s,
                q.stem_acceleration_m_s2,
                q.reference_rate_m_s,
                heat,
                0.,
                0.,
            ];
            for j in 0..WIDTH {
                w.residual[r + j] = yp[r + j] - rr[j];
            }
            water_power += f.body_n * s.body_v_m_s + f.stem_n * s.stem_v_m_s;
            mechanical_power += c.body_mass_kg
                * (s.body_v_m_s * q.body_acceleration_m_s2 + GRAVITY * s.body_v_m_s)
                + c.stem_mass_kg
                    * (s.stem_v_m_s * q.stem_acceleration_m_s2 + GRAVITY * s.stem_v_m_s);
            apparatus_heat += heat;
            w.responses.push(q);
        }
        w.residual[self.layout.fluid_mechanical_work] =
            yp[self.layout.fluid_mechanical_work] - water_power;
        for r in 0..self.dimension() {
            w.rates[r] = yp[r] - w.residual[r];
        }
        w.thermal_work_rate =
            w.cooling.complete_energy_rate()? + w.fluid.stem_fluid_work_w + water_power;
        w.energy_rate = w.cooling.complete_energy_rate()?
            + w.fluid.stem_fluid_work_w
            + mechanical_power
            + apparatus_heat
            - mode.input.motive_power_w
            - mode.input.holding_power_w;
        if w.residual.iter().any(|v| !v.is_finite()) || !w.energy_rate.is_finite() {
            return Err("Nonfinite connected mechanical residual/work".into());
        }
        w.state.copy_from_slice(y);
        w.mode = Some(mode.clone());
        w.cj = cj;
        w.valid = true;
        Ok(())
    }
    pub fn select_mode(&self, y: &[f64], w: &Workspace, input: Input) -> Result<Mode, String> {
        self.require_current(y, w)?;
        validate_input(input)?;
        if self
            .config
            .iter()
            .any(|c| input.requested_rate_m_s.abs() > c.maximum_rate_m_s)
        {
            return Err("Connected request exceeds selected ordinary speed".into());
        }
        let mut mode = w.mode.as_ref().unwrap().clone();
        mode.input = input;
        let i = self.per_cluster_input(input);
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            mode.branches[k] = self.config[k].branch(state(&y[r..r + WIDTH]), i, w.forces[k])?;
        }
        Ok(mode)
    }
    /// Explicit geometry-time direction for differentiated fluid charts at
    /// initialization/events. It consumes this stage's actual velocities and
    /// accelerations and introduces no second motion or integration clock.
    pub fn prepare_time_direction(&self, w: &mut Workspace) -> Result<(), String> {
        if !w.valid || !Arc::ptr_eq(&self.owner, &w.owner) {
            return Err("Geometry-time action requires current connected mechanics".into());
        }
        w.valid = false;
        for k in 0..self.clusters() {
            w.dposes[k] = w.velocity[k];
            w.dvelocity[k] = cg::Direction {
                body: w.responses[k].body_acceleration_m_s2,
                stem: w.responses[k].stem_acceleration_m_s2,
            };
        }
        self.geometry
            .evaluate_into(&w.poses, &w.dposes, &mut w.geometry)?;
        self.geometry
            .water_rates_into(&w.velocity, &w.dvelocity, &mut w.geometry)?;
        for j in 0..w.dwater.len() {
            let v = w.geometry.direction.water[j];
            let r = w.geometry.water_rate_direction[j];
            w.dwater[j] = on::WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            };
        }
        self.hydraulics
            .directions_into(&w.dposes, &w.dvelocity, &mut w.dconnections)?;
        w.valid = true;
        Ok(())
    }
    pub fn set_mechanical_rates(
        &self,
        y: &[f64],
        yp: &mut [f64],
        w: &Workspace,
    ) -> Result<(), String> {
        self.require_current(y, w)?;
        if yp.len() != self.dimension() {
            return Err("Wrong connected rate vector".into());
        }
        yp[self.layout.cooling_end..].copy_from_slice(&w.rates[self.layout.cooling_end..]);
        Ok(())
    }
    /// Complete analytic action, including the current geometry, fluid-force,
    /// neck-work, contact and finite-heat chains from this exact value stage.
    pub fn jvp(&self, dy: &[f64], cj: f64, w: &mut Workspace) -> Result<(), String> {
        w.energy_tangent = None;
        w.thermal_work_tangent = None;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || w.cj != Some(cj)
            || dy.len() != self.dimension()
            || dy.iter().any(|v| !v.is_finite())
        {
            return Err("Connected mechanical JVP requires its current owned stage and cj".into());
        }
        w.valid = false;
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            w.dposes[k] = cg::Direction {
                body: dy[r + BODY_Y],
                stem: dy[r + STEM_Y],
            };
            w.dvelocity[k] = cg::Direction {
                body: dy[r + BODY_V],
                stem: dy[r + STEM_V],
            };
        }
        self.geometry
            .evaluate_into(&w.poses, &w.dposes, &mut w.geometry)?;
        self.geometry
            .water_rates_into(&w.velocity, &w.dvelocity, &mut w.geometry)?;
        for j in 0..w.dwater.len() {
            let v = w.geometry.direction.water[j];
            let r = w.geometry.water_rate_direction[j];
            w.dwater[j] = on::WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            };
        }
        self.hydraulics
            .directions_into(&w.dposes, &w.dvelocity, &mut w.dconnections)?;
        let l = self.cooling.layout;
        let end = self.layout.cooling_end;
        self.cooling.jvp_with_current_geometry(
            &dy[..end],
            cj,
            &mut w.cooling,
            sc::GeometryDirection {
                source: &w.geometry.direction.source,
                contacts: &w.geometry.direction.contacts,
                mobile: &w.geometry.direction.mobile,
                barrel_chords_m: &w.geometry.direction.barrel_chords_m,
                water: &w.dwater,
                connections: &w.dconnections,
            },
        )?;
        let dwork = self.hydraulics.direction(
            &self.cooling.network,
            &w.state[l.network_start..l.carrier_start],
            &w.cooling.network,
            &w.geometry,
            &dy[l.network_start..l.carrier_start],
            &w.dposes,
            &w.dvelocity,
            &w.fluid,
            &mut w.dforces,
        )?;
        w.jvp[..end].copy_from_slice(&w.cooling.jvp);
        let upper = l.network_start + self.cooling.network.energy_row(self.hydraulics.upper);
        w.jvp[upper] -= dwork;
        let mode = w.mode.as_ref().unwrap();
        let input = self.per_cluster_input(mode.input);
        let mut water_tangent = 0.;
        let mut mechanical_tangent = 0.;
        let mut heat_tangent = 0.;
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&w.state[r..r + WIDTH]);
            let ds = state(&dy[r..r + WIDTH]);
            let c = self.config[k];
            let f = w.fluid.forces[k];
            let df = w.dforces[k];
            let q = w.responses[k];
            let dq = c.evaluate_trial_direction(s, input, w.forces[k], mode.branches[k], ds, df)?;
            let heat = dq.slip_to_jack_w + dq.electrical_loss_to_jack_w;
            let rates = [
                ds.body_v_m_s,
                dq.body_acceleration_m_s2,
                ds.stem_v_m_s,
                dq.stem_acceleration_m_s2,
                dq.reference_rate_m_s,
                heat,
                0.,
                0.,
            ];
            for j in 0..WIDTH {
                w.jvp[r + j] = cj * dy[r + j] - rates[j];
            }
            water_tangent += df.body_n * s.body_v_m_s
                + f.body_n * ds.body_v_m_s
                + df.stem_n * s.stem_v_m_s
                + f.stem_n * ds.stem_v_m_s;
            mechanical_tangent += c.body_mass_kg
                * (ds.body_v_m_s * q.body_acceleration_m_s2
                    + s.body_v_m_s * dq.body_acceleration_m_s2
                    + GRAVITY * ds.body_v_m_s)
                + c.stem_mass_kg
                    * (ds.stem_v_m_s * q.stem_acceleration_m_s2
                        + s.stem_v_m_s * dq.stem_acceleration_m_s2
                        + GRAVITY * ds.stem_v_m_s);
            heat_tangent += heat;
        }
        w.jvp[self.layout.fluid_mechanical_work] =
            cj * dy[self.layout.fluid_mechanical_work] - water_tangent;
        w.thermal_work_tangent =
            Some(w.cooling.complete_energy_rate_jvp()? + dwork + water_tangent);
        w.energy_tangent =
            Some(w.cooling.complete_energy_rate_jvp()? + dwork + mechanical_tangent + heat_tangent);
        if w.jvp.iter().any(|v| !v.is_finite()) || !w.energy_tangent.unwrap().is_finite() {
            return Err("Nonfinite connected mechanical Jacobian/work action".into());
        }
        w.valid = true;
        Ok(())
    }
    /// Small held-fluid mechanics/heat/work block for a component
    /// preconditioner. No SOURCE JVP, geometry rebuild, EOS call or numerical
    /// column probe occurs here. Cross-component feedback remains in `jvp`.
    pub fn visit_mechanical_jacobian(
        &self,
        w: &Workspace,
        cj: f64,
        mut visit: impl FnMut(usize, usize, f64),
    ) -> Result<(), String> {
        if !w.valid || !Arc::ptr_eq(&self.owner, &w.owner) || w.cj != Some(cj) {
            return Err("Mechanical preconditioner requires current owned linearization".into());
        }
        let mode = w.mode.as_ref().unwrap();
        let input = self.per_cluster_input(mode.input);
        let zero = cg::Direction { body: 0., stem: 0. };
        let mut dpose = vec![zero; self.clusters()];
        let mut dvelocity = dpose.clone();
        let dn = vec![0.; self.cooling.network.dimension()];
        let mut df = vec![
            am::Forces {
                body_n: 0.,
                stem_n: 0.
            };
            self.clusters()
        ];
        let l = self.cooling.layout;
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&w.state[r..r + WIDTH]);
            let c = self.config[k];
            for col in 0..5 {
                dpose[k] = cg::Direction {
                    body: if col == BODY_Y { 1. } else { 0. },
                    stem: if col == STEM_Y { 1. } else { 0. },
                };
                dvelocity[k] = cg::Direction {
                    body: if col == BODY_V { 1. } else { 0. },
                    stem: if col == STEM_V { 1. } else { 0. },
                };
                self.hydraulics.direction(
                    &self.cooling.network,
                    &w.state[l.network_start..l.carrier_start],
                    &w.cooling.network,
                    &w.geometry,
                    &dn,
                    &dpose,
                    &dvelocity,
                    &w.fluid,
                    &mut df,
                )?;
                let mut local = [0.; WIDTH];
                local[col] = 1.;
                let ds = state(&local);
                let dq =
                    c.evaluate_trial_direction(s, input, w.forces[k], mode.branches[k], ds, df[k])?;
                let dr = [
                    ds.body_v_m_s,
                    dq.body_acceleration_m_s2,
                    ds.stem_v_m_s,
                    dq.stem_acceleration_m_s2,
                    dq.reference_rate_m_s,
                    dq.slip_to_jack_w + dq.electrical_loss_to_jack_w,
                    0.,
                    0.,
                ];
                for row in 0..WIDTH {
                    visit(
                        r + row,
                        r + col,
                        if row == col { cj - dr[row] } else { -dr[row] },
                    );
                }
                let f = w.fluid.forces[k];
                let work = df[k].body_n * s.body_v_m_s
                    + f.body_n * ds.body_v_m_s
                    + df[k].stem_n * s.stem_v_m_s
                    + f.stem_n * ds.stem_v_m_s;
                visit(self.layout.fluid_mechanical_work, r + col, -work);
            }
            dpose[k] = zero;
            dvelocity[k] = zero;
            for col in 5..WIDTH {
                visit(r + col, r + col, cj);
            }
        }
        visit(
            self.layout.fluid_mechanical_work,
            self.layout.fluid_mechanical_work,
            cj,
        );
        Ok(())
    }
    fn require_current(&self, y: &[f64], w: &Workspace) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || y.len() != self.dimension()
            || y.iter()
                .zip(&w.state)
                .any(|(a, b)| a.to_bits() != b.to_bits())
        {
            return Err("Connected operation requires its freshly evaluated candidate".into());
        }
        Ok(())
    }
    pub fn mechanical_energy_j(&self, y: &[f64]) -> Result<f64, String> {
        if y.len() != self.dimension() {
            return Err("Wrong connected mechanical state".into());
        }
        let mut total = 0.;
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            total += self.config[k].mechanical_energy_j(state(&y[r..r + WIDTH]), GRAVITY)?;
        }
        Ok(total)
    }
    pub fn apparatus_heat_j(&self, y: &[f64]) -> Result<f64, String> {
        if y.len() != self.dimension() {
            return Err("Wrong connected apparatus heat state".into());
        }
        Ok((0..self.clusters())
            .map(|k| {
                let r = self.motion_row(k, 0);
                y[r + JACK_HEAT] + y[r + STEM_HEAT] + y[r + SPIDER_HEAT]
            })
            .sum())
    }
    pub fn roots(&self, y: &[f64], w: &Workspace, out: &mut [f64]) -> Result<(), String> {
        self.require_current(y, w)?;
        self.fill_roots(y, w.mode.as_ref().unwrap(), &w.responses, out)
    }
    fn fill_roots(
        &self,
        y: &[f64],
        mode: &Mode,
        responses: &[am::Response],
        out: &mut [f64],
    ) -> Result<(), String> {
        if out.len() != self.root_count() {
            return Err("Wrong connected motion root vector".into());
        }
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&y[r..r + WIDTH]);
            let b = mode.branches[k];
            let speed = match b.regulator {
                am::RegulatorBranch::ApproachPositive | am::RegulatorBranch::ApproachNegative => {
                    s.stem_v_m_s - mode.input.requested_rate_m_s
                }
                am::RegulatorBranch::HoldPositive | am::RegulatorBranch::HoldNegative => {
                    s.stem_v_m_s
                }
                _ => 1.,
            };
            out[4 * k..4 * k + 4].copy_from_slice(&[
                speed,
                if b.joint == am::JointMode::Separated {
                    s.body_y_m - s.stem_y_m
                } else {
                    1.
                },
                if b.joint == am::JointMode::Contact {
                    responses[k].joint_force_n
                } else {
                    1.
                },
                s.body_y_m,
            ]);
        }
        Ok(())
    }
    /// Atomic accepted root transaction. All coincident cluster events are
    /// applied before one caller-owned consistency treatment. Continuous
    /// switches preserve every stock bit; a finite contact impulse pays its
    /// KE loss to the existing appended stem/spider heat owners.
    pub fn accept_roots(
        &self,
        y: &mut [f64],
        w: &Workspace,
        mode: &mut Mode,
        roots: &[i32],
        accuracy: RootAccuracy,
    ) -> Result<EventReport, String> {
        self.require_current(y, w)?;
        if w.mode.as_ref() != Some(mode)
            || roots.len() != self.root_count()
            || ![accuracy.position_m, accuracy.velocity_m_s]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
        {
            return Err("Invalid connected mechanical root transaction".into());
        }
        let mut next = y.to_vec();
        let mut branch = mode.clone();
        let mut report = EventReport::default();
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let mut s = state(&next[r..r + WIDTH]);
            let c = self.config[k];
            if roots[4 * k + 3] != 0 {
                return Err(format!(
                    "Cluster {k} reaches unqualified incoming fitting contact"
                ));
            }
            if roots[4 * k] != 0 {
                let regulator = branch.branches[k].regulator;
                if !matches!(
                    regulator,
                    am::RegulatorBranch::ApproachPositive
                        | am::RegulatorBranch::ApproachNegative
                        | am::RegulatorBranch::HoldPositive
                        | am::RegulatorBranch::HoldNegative
                ) {
                    return Err("Inactive connected speed root".into());
                }
                let target = mode.input.requested_rate_m_s;
                let adjustment = (s.stem_v_m_s - target).abs();
                if adjustment > 0.1 * accuracy.velocity_m_s {
                    return Err("Unresolved connected speed root".into());
                }
                report.maximum_velocity_adjustment_m_s =
                    report.maximum_velocity_adjustment_m_s.max(adjustment);
                // Represent the located ideal-graph equality at its declared
                // root resolution, following the existing mechanical owner.
                // Keep its signed numerical energy change outside real heat.
                let before = c.mechanical_energy_j(s, GRAVITY)?;
                s.stem_v_m_s = target;
                if branch.branches[k].joint == am::JointMode::Contact {
                    s.body_v_m_s = target;
                }
                report.mechanical_adjustment_j += c.mechanical_energy_j(s, GRAVITY)? - before;
                report.needs_fluid_initialization |= adjustment != 0.;
                write_state(&mut next[r..r + WIDTH], s);
                branch.branches[k].regulator = if target == 0. {
                    am::RegulatorBranch::HoldRest
                } else {
                    am::RegulatorBranch::Track
                };
                report.velocity_events += 1;
            }
            if roots[4 * k + 1] != 0 {
                if branch.branches[k].joint != am::JointMode::Separated {
                    return Err("Inactive connected contact root".into());
                }
                let adjustment = (s.body_y_m - s.stem_y_m).abs();
                if adjustment > 0.1 * accuracy.position_m {
                    return Err("Unresolved connected bayonet root".into());
                }
                report.maximum_position_adjustment_m =
                    report.maximum_position_adjustment_m.max(adjustment);
                let before = c.mechanical_energy_j(s, GRAVITY)?;
                let plane = (c.body_mass_kg * s.body_y_m + c.stem_mass_kg * s.stem_y_m)
                    / (c.body_mass_kg + c.stem_mass_kg);
                s.body_y_m = plane;
                s.stem_y_m = plane;
                report.mechanical_adjustment_j += c.mechanical_energy_j(s, GRAVITY)? - before;
                if s.body_v_m_s < s.stem_v_m_s {
                    let impact = c.recontact(s)?;
                    s = impact.state;
                    next[r + STEM_HEAT] += impact.stem_heat_j;
                    next[r + SPIDER_HEAT] += impact.spider_heat_j;
                    report.contact_heat_j += impact.stem_heat_j + impact.spider_heat_j;
                }
                branch.branches[k].joint = am::JointMode::Contact;
                branch.branches[k].regulator = if mode.input.requested_rate_m_s == 0. {
                    if s.stem_v_m_s > 0. {
                        am::RegulatorBranch::HoldPositive
                    } else if s.stem_v_m_s < 0. {
                        am::RegulatorBranch::HoldNegative
                    } else {
                        am::RegulatorBranch::HoldRest
                    }
                } else if s.stem_v_m_s < mode.input.requested_rate_m_s {
                    am::RegulatorBranch::ApproachPositive
                } else if s.stem_v_m_s > mode.input.requested_rate_m_s {
                    am::RegulatorBranch::ApproachNegative
                } else {
                    am::RegulatorBranch::Track
                };
                report.contact_events += 1;
                report.needs_fluid_initialization = true;
                write_state(&mut next[r..r + WIDTH], s);
            }
            if roots[4 * k + 2] != 0 {
                if branch.branches[k].joint != am::JointMode::Contact {
                    return Err("Inactive connected separation root".into());
                }
                branch.branches[k].joint = am::JointMode::Separated;
                report.separation_events += 1;
            }
        }
        y.copy_from_slice(&next);
        *mode = branch;
        Ok(report)
    }
    pub fn validate_accepted(&self, y: &[f64], w: &Workspace) -> Result<(), String> {
        self.require_current(y, w)?;
        self.cooling
            .validate_accepted(&y[..self.layout.cooling_end], &w.cooling)?;
        let input = self.per_cluster_input(w.mode.as_ref().unwrap().input);
        for k in 0..self.clusters() {
            let r = self.motion_row(k, 0);
            let s = state(&y[r..r + WIDTH]);
            if s.body_y_m < 0.
                || s.body_y_m < s.stem_y_m
                || y[r + JACK_HEAT..r + WIDTH].iter().any(|v| *v < 0.)
            {
                return Err(format!(
                    "Invalid accepted cluster {k} pose/contact/finite heat"
                ));
            }
            let mode = w.mode.as_ref().unwrap().branches[k];
            if (mode.joint == am::JointMode::Contact
                && (s.body_y_m != s.stem_y_m
                    || s.body_v_m_s != s.stem_v_m_s
                    || w.responses[k].joint_force_n < 0.))
                || (mode.regulator == am::RegulatorBranch::Track
                    && s.stem_v_m_s != input.requested_rate_m_s)
                || (mode.regulator == am::RegulatorBranch::HoldRest && s.stem_v_m_s != 0.)
                || (mode.regulator == am::RegulatorBranch::HoldPositive && s.stem_v_m_s < 0.)
                || (mode.regulator == am::RegulatorBranch::HoldNegative && s.stem_v_m_s > 0.)
                || (mode.regulator == am::RegulatorBranch::ApproachPositive
                    && s.stem_v_m_s > input.requested_rate_m_s)
                || (mode.regulator == am::RegulatorBranch::ApproachNegative
                    && s.stem_v_m_s < input.requested_rate_m_s)
            {
                let response = w.responses[k];
                let cap = self.config[k].grip_closed_force_n
                    * (1. - input.gap_m / self.config[k].gap_stroke_m);
                return Err(format!(
                    "Accepted cluster {k} does not lie on its retained force/contact branch: \
                     mode={mode:?}, body_y={:e}, stem_y={:e}, body_v={:e}, stem_v={:e}, \
                     requested_v={:e}, contact_pose_equal={}, contact_velocity_equal={}, \
                     joint_nonnegative={}, stem_at_request={}, stem_at_rest={}, \
                     hold_positive_side={}, hold_negative_side={}, \
                     approach_positive_side={}, approach_negative_side={}, \
                     joint_force={:e}, grip_force={:e}, grip_capacity={cap:e}, \
                     body_force={:e}, stem_force={:e}, body_acceleration={:e}, \
                     stem_acceleration={:e}",
                    s.body_y_m,
                    s.stem_y_m,
                    s.body_v_m_s,
                    s.stem_v_m_s,
                    input.requested_rate_m_s,
                    s.body_y_m == s.stem_y_m,
                    s.body_v_m_s == s.stem_v_m_s,
                    response.joint_force_n >= 0.,
                    s.stem_v_m_s == input.requested_rate_m_s,
                    s.stem_v_m_s == 0.,
                    s.stem_v_m_s >= 0.,
                    s.stem_v_m_s <= 0.,
                    s.stem_v_m_s <= input.requested_rate_m_s,
                    s.stem_v_m_s >= input.requested_rate_m_s,
                    response.joint_force_n,
                    response.grip_force_n,
                    w.forces[k].body_n,
                    w.forces[k].stem_n,
                    response.body_acceleration_m_s2,
                    response.stem_acceleration_m_s2,
                ));
            }
            self.config[k].evaluate(s, input, w.forces[k])?;
        }
        Ok(())
    }
}

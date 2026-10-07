//! Provisional qualification-only consequences, not deposited recipient heat
//! or a guarantee of near-critical sensitivity. No source law is changed.
use super::{COUNT_ATOL, ENERGY_ATOL, Evolution, fuel_history, heat_history, ratio};

pub(super) const POLICY: &str = "source-consequences-1";
const RELATIVE: f64 = 1e-3;
#[derive(Clone)]
struct Channel {
    rows: Vec<usize>,
    q: f64,
    family: &'static str,
    activity: bool,
}
struct Donor {
    rows: Vec<usize>,
    reference: f64,
}
pub(super) struct Accuracy {
    normal_absolute: Vec<f64>,
    affected: Vec<bool>,
    channels: Vec<Channel>,
    donors: Vec<Donor>,
}
pub(super) struct Consequence {
    pub row: usize,
    pub family: &'static str,
    pub normal: f64,
    pub tighter: f64,
    pub difference: f64,
    pub bound: f64,
    pub ratio: f64,
}
fn resolution(reference: f64, q: f64) -> Result<f64, String> {
    if !reference.is_finite() || reference < 0. || !q.is_finite() || q < 0. {
        return Err("Invalid consequence reference/Q".into());
    }
    if reference == 0. {
        // Structural zeros remain subject to the native exact zero domain.
        return Ok(COUNT_ATOL);
    }
    let cap = RELATIVE * reference / 20.;
    let value = if q == 0. {
        cap
    } else {
        cap.min(ENERGY_ATOL / q)
    };
    if !value.is_finite() || value <= 0. {
        return Err("Underflow/nonpositive consequence resolution".into());
    }
    Ok(value)
}
impl Accuracy {
    pub fn new(model: &Evolution, emissions: &[[f64; 2]]) -> Result<Self, String> {
        if emissions.len() != model.target_reference_atoms().len() {
            return Err("Wrong consequence emission table dimension".into());
        }
        let mut policy = Self {
            normal_absolute: vec![COUNT_ATOL; model.state_count()],
            affected: vec![false; model.state_count()],
            channels: Vec::new(),
            donors: Vec::new(),
        };
        for row in model.energy_rows() {
            policy.normal_absolute[row] = ENERGY_ATOL;
        }
        let fuel = model.fuel_history();
        let capture_q = fuel
            .energy_groups()
            .iter()
            .filter(|g| matches!(g.feed, heat_history::Feed::FertileCapture))
            .map(|g| g.energy_per_event)
            .sum::<f64>();
        for (s, preparation) in fuel.segment_preparations().iter().enumerate() {
            let row = |slot| model.nc_dimension() + s * fuel_history::HISTORY + slot;
            policy.replace(
                row(fuel_history::CONSUMED_235),
                preparation.reference_u235,
                fuel.fission_energy(),
            )?;
            policy.replace(
                row(fuel_history::CAPTURED_238),
                preparation.reference_u238,
                capture_q,
            )?;
            policy.replace(
                row(fuel_history::SF_238),
                preparation.reference_u238,
                fuel.fission_energy(),
            )?;
            policy.channel(
                vec![row(fuel_history::CONSUMED_235)],
                fuel.fission_energy(),
                "fuel-fission-paid-energy",
                false,
            )?;
            // E25 feeds ONLY: prompt fertile-capture binding and its future
            // thermal recipient are not installed by this qualification.
            policy.channel(
                vec![row(fuel_history::CAPTURED_238)],
                capture_q,
                "represented-fertile-E25-feed",
                false,
            )?;
            policy.channel(
                vec![row(fuel_history::SF_238)],
                fuel.fission_energy(),
                "SF238-paid-energy",
                false,
            )?;
            policy.donor(
                vec![row(fuel_history::CONSUMED_235)],
                preparation.reference_u235,
            )?;
            policy.donor(
                vec![row(fuel_history::CAPTURED_238), row(fuel_history::SF_238)],
                preparation.reference_u238,
            )?;
        }
        let law = model.moderator_law();
        for (owner, water) in model.water_owners().iter().enumerate() {
            for (boron, reference, emission, family) in [
                (
                    false,
                    water.hydrogen,
                    law.hydrogen_emission,
                    "water-H-binding-emission",
                ),
                (
                    true,
                    water.boron,
                    law.boron_emission,
                    "water-B-binding-emission",
                ),
            ] {
                // External primary products are owned and assessed by the
                // coupled carrier, not duplicated in this source-only view.
                let Some(row) = model.closed_water_row(owner, boron) else {
                    continue;
                };
                let q = emission[0] + emission[1];
                policy.replace(row, reference, q)?;
                policy.channel(vec![row], q, family, false)?;
                policy.donor(vec![row], reference)?;
            }
        }
        for (target, (&reference, emission)) in model
            .target_reference_atoms()
            .iter()
            .zip(emissions)
            .enumerate()
        {
            if emission.iter().any(|v| !v.is_finite() || *v < 0.) {
                return Err("Invalid target consequence emission".into());
            }
            let row = model.target_row(target);
            let q = emission[0] + emission[1];
            let mn = model
                .mn_targets()
                .iter()
                .enumerate()
                .find(|(_, m)| m.target == target);
            let rows = if let Some((index, m)) = mn {
                let decay_q = m.electron_j + m.photon_j;
                if decay_q > 0. && m.decay_rate > 0. && decay_q * m.decay_rate == 0. {
                    return Err("Underflowed positive Mn decay-power coefficient".into());
                }
                policy.replace(row, reference, q.max(decay_q))?;
                policy.channel(vec![row], decay_q, "Mn-decay-energy-potential", false)?;
                policy.channel(vec![row], decay_q * m.decay_rate, "Mn-decay-power", true)?;
                // Fe product keeps its original strict count weight/check.
                vec![row, model.mn_product_row(index)]
            } else {
                policy.replace(row, reference, q)?;
                vec![row]
            };
            policy.channel(rows.clone(), q, "target-binding-emission", false)?;
            policy.donor(rows, reference)?;
        }
        Ok(policy)
    }
    fn replace(&mut self, row: usize, reference: f64, q: f64) -> Result<(), String> {
        self.normal_absolute[row] = resolution(reference, q)?;
        self.affected[row] = true;
        Ok(())
    }
    fn channel(
        &mut self,
        rows: Vec<usize>,
        q: f64,
        family: &'static str,
        activity: bool,
    ) -> Result<(), String> {
        if !q.is_finite() || q < 0. {
            return Err("Invalid consequence channel Q".into());
        }
        self.channels.push(Channel {
            rows,
            q,
            family,
            activity,
        });
        Ok(())
    }
    fn donor(&mut self, rows: Vec<usize>, reference: f64) -> Result<(), String> {
        if !reference.is_finite() || reference < 0. {
            return Err("Invalid donor reference".into());
        }
        self.donors.push(Donor { rows, reference });
        Ok(())
    }
    pub fn affected(&self, row: usize) -> bool {
        self.affected[row]
    }
    pub fn absolute(&self, refinement: f64) -> Result<Vec<f64>, String> {
        if !refinement.is_finite() || refinement <= 0. {
            return Err("Invalid tolerance refinement".into());
        }
        let values = self
            .normal_absolute
            .iter()
            .map(|v| v / refinement)
            .collect::<Vec<_>>();
        if values.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err("Invalid refined absolute tolerance".into());
        }
        Ok(values)
    }
    pub fn consequences(
        &self,
        a: &[f64],
        b: &[f64],
        time: f64,
    ) -> Result<Vec<Consequence>, String> {
        if a.len() != self.affected.len() || b.len() != a.len() || !time.is_finite() || time <= 0. {
            return Err("Invalid consequence comparison shape/time".into());
        }
        let mut out = Vec::with_capacity(self.channels.len() + self.donors.len());
        for channel in &self.channels {
            let x = channel.rows.iter().map(|&i| a[i]).sum::<f64>();
            let y = channel.rows.iter().map(|&i| b[i]).sum::<f64>();
            let normal = channel.q * x;
            let tighter = channel.q * y;
            let difference =
                channel.q * channel.rows.iter().map(|&i| a[i] - b[i]).sum::<f64>().abs();
            let floor = if channel.activity {
                ENERGY_ATOL / time
            } else {
                ENERGY_ATOL
            };
            let bound = RELATIVE * tighter.abs() + 20. * floor;
            if !normal.is_finite() || !tighter.is_finite() {
                return Err("Nonfinite consequence output".into());
            }
            out.push(Consequence {
                row: channel.rows[0],
                family: channel.family,
                normal,
                tighter,
                difference,
                bound,
                ratio: ratio(difference, bound)?,
            });
        }
        for donor in &self.donors {
            let x = donor.rows.iter().map(|&i| a[i]).sum::<f64>();
            let y = donor.rows.iter().map(|&i| b[i]).sum::<f64>();
            let difference = donor.rows.iter().map(|&i| a[i] - b[i]).sum::<f64>().abs();
            let bound = RELATIVE * (donor.reference - y).abs() + 20. * COUNT_ATOL;
            if !x.is_finite() || !y.is_finite() || x > donor.reference || y > donor.reference {
                return Err("Invalid combined donor consumption".into());
            }
            if donor.reference == 0. && (x != 0. || y != 0.) {
                return Err("Nonzero structural-zero consumption".into());
            }
            out.push(Consequence {
                row: donor.rows[0],
                family: "remaining-donor-count",
                normal: donor.reference - x,
                tighter: donor.reference - y,
                difference,
                bound,
                ratio: ratio(difference, bound)?,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
#[path = "../tests/source_evolution.rs"]
mod source_fixture;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolutions_are_owned_energy_equivalents_capped_by_composition() {
        assert_eq!(resolution(0., 1.).unwrap(), COUNT_ATOL);
        assert_eq!(resolution(1e30, 1e-12).unwrap(), 1.);
        assert_eq!(resolution(100., 0.).unwrap(), 0.005);
        assert!(resolution(f64::MIN_POSITIVE / 1e12, 0.).is_err());
        assert!(resolution(1., f64::INFINITY).is_err());
    }
    #[test]
    fn combined_donor_and_energy_differences_do_not_subtract_huge_reserves() {
        let policy = Accuracy {
            normal_absolute: vec![1., 1.],
            affected: vec![true, true],
            channels: vec![Channel {
                rows: vec![0, 1],
                q: 1e-12,
                family: "test",
                activity: false,
            }],
            donors: vec![Donor {
                rows: vec![0, 1],
                reference: 1e30,
            }],
        };
        let result = policy.consequences(&[2., 3.], &[1., 3.], 1.).unwrap();
        assert_eq!(result[0].difference, 1e-12);
        assert_eq!(result[1].difference, 1.);
        let result = policy.consequences(&[1., 1e30], &[2., 1e30], 1.).unwrap();
        assert_eq!(result[0].normal, result[0].tighter);
        assert_eq!(result[0].difference, 1e-12);
        assert_eq!(result[1].difference, 1.);
        assert_eq!(policy.absolute(10.).unwrap(), vec![0.1, 0.1]);
        let near = Accuracy {
            normal_absolute: vec![1., 1.],
            affected: vec![true, true],
            channels: vec![],
            donors: vec![Donor {
                rows: vec![0, 1],
                reference: 10.,
            }],
        };
        assert_eq!(
            near.consequences(&[4., 5.], &[5., 5.], 1.).unwrap()[0].bound,
            20. * COUNT_ATOL
        );
        assert!(near.consequences(&[6., 5.], &[5., 5.], 1.).is_err());
        assert!(
            near.consequences(&[f64::INFINITY, 0.], &[0., 0.], 1.)
                .is_err()
        );
        let zero = Accuracy {
            normal_absolute: vec![COUNT_ATOL],
            affected: vec![true],
            channels: vec![],
            donors: vec![Donor {
                rows: vec![0],
                reference: 0.,
            }],
        };
        assert!(zero.consequences(&[-1e-100], &[0.], 1.).is_err());
        assert!(zero.consequences(&[1e-100], &[0.], 1.).is_err());
        assert_eq!(zero.consequences(&[0.], &[0.], 1.).unwrap()[0].ratio, 0.);
    }
    #[test]
    fn owner_channels_cannot_hide_redistribution_and_positive_power_underflow_refuses() {
        let policy = Accuracy {
            normal_absolute: vec![1., 1.],
            affected: vec![true, true],
            channels: vec![
                Channel {
                    rows: vec![0],
                    q: 1.,
                    family: "owner-a",
                    activity: false,
                },
                Channel {
                    rows: vec![1],
                    q: 1.,
                    family: "owner-b",
                    activity: false,
                },
            ],
            donors: vec![],
        };
        let result = policy.consequences(&[11., 9.], &[10., 10.], 1.).unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|c| c.ratio > 1.));
        let mut input = super::source_fixture::input();
        input.mn[0].electron_j = f64::from_bits(1);
        input.mn[0].photon_j = 0.;
        input.mn[0].decay_rate = 1e-100;
        let model = Evolution::new(input).unwrap();
        let error = Accuracy::new(&model, &vec![[0.; 2]; model.target_reference_atoms().len()])
            .err()
            .unwrap();
        assert_eq!(error, "Underflowed positive Mn decay-power coefficient");
    }
}

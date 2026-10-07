//! Small compiled response of the SAME paid fuel-heat incidence. No new heat
//! law, time integration, temperature closure or observable registry.
use super::*;

enum Term {
    Prompt {
        n: usize,
        spent: usize,
        reference: f64,
        gain: f64,
    },
    Spontaneous {
        first: usize,
        second: Option<usize>,
        reference: f64,
        power: f64,
    },
    Retained {
        energy: usize,
        gain: f64,
    },
}
impl Term {
    fn columns(&self) -> [Option<usize>; 2] {
        match *self {
            Self::Prompt { n, spent, .. } => [Some(n), Some(spent)],
            Self::Spontaneous { first, second, .. } => [Some(first), second],
            Self::Retained { energy, .. } => [Some(energy), None],
        }
    }
}
struct Row {
    terms: Vec<Term>,
    /// Local coalesced derivative slots, compiled once; no map lookup in eval.
    slots: Vec<[Option<usize>; 2]>,
}
pub struct PowerResponse {
    state_count: usize,
    rows: Vec<Row>,
    offsets: Vec<usize>,
    columns: Vec<usize>,
}
impl PowerResponse {
    pub(super) fn new(a: &Assembly) -> Result<Self, &'static str> {
        let mut terms: Vec<Vec<Term>> = (0..a.fuel.cohorts().len()).map(|_| Vec::new()).collect();
        let mut unrepresentable = false;
        a.fuel.visit_heat_incidence(|q, intersection, fraction| {
            unrepresentable |= !fraction.is_finite() || fraction <= 0.;
            let segment = a.fuel.cohorts()[q].segment;
            let p = a.segments[segment];
            let row = a.history_row(segment, 0);
            if let Some(i) = intersection {
                let e = &a.fuel.intersections()[i];
                for g in 0..GROUPS {
                    let gain = a.prompt_fission_energy * fraction * a.fuel.reference_fission(i, g);
                    let active = a.prompt_fission_energy > 0. && a.fuel.law().fission[g] > 0.;
                    unrepresentable |= !gain.is_finite() || (active && gain == 0.);
                    if active {
                        terms[q].push(Term::Prompt {
                            n: e.region * GROUPS + g,
                            spent: row + CONSUMED_235,
                            reference: p.reference_u235,
                            gain,
                        });
                    }
                }
            } else {
                for (first, second, reference, neutrons) in [
                    (
                        row + CONSUMED_235,
                        None,
                        p.reference_u235,
                        p.sf235_neutrons_per_second,
                    ),
                    (
                        row + CAPTURED_238,
                        Some(row + SF_238),
                        p.reference_u238,
                        p.sf238_neutrons_per_second,
                    ),
                ] {
                    let power = fraction * a.prompt_fission_energy * neutrons
                        / a.spontaneous_neutrons_per_event;
                    let active = a.prompt_fission_energy > 0. && neutrons > 0.;
                    unrepresentable |= !power.is_finite() || (active && power == 0.);
                    if active {
                        terms[q].push(Term::Spontaneous {
                            first,
                            second,
                            reference,
                            power,
                        });
                    }
                }
                for (j, group) in a.heat.groups().iter().enumerate() {
                    let gain = fraction * group.decay_rate;
                    unrepresentable |= !gain.is_finite() || gain == 0.;
                    if gain != 0. {
                        terms[q].push(Term::Retained {
                            energy: row + ENERGY + j,
                            gain,
                        });
                    }
                }
            }
        });
        if unrepresentable {
            return Err("Unrepresentable structural fuel-power coefficient");
        }
        let mut offsets = vec![0];
        let mut columns = Vec::new();
        let mut rows = Vec::with_capacity(terms.len());
        for terms in terms {
            let mut local: Vec<_> = terms.iter().flat_map(Term::columns).flatten().collect();
            local.sort_unstable();
            local.dedup();
            let slots = terms
                .iter()
                .map(|t| {
                    t.columns()
                        .map(|c| c.map(|c| local.binary_search(&c).unwrap()))
                })
                .collect();
            columns.extend(local);
            offsets.push(columns.len());
            rows.push(Row { terms, slots });
        }
        let result = Self {
            state_count: a.state_count(),
            rows,
            offsets,
            columns,
        };
        // Compile-time overflow is refused even at the zero original state.
        result.evaluate(
            &vec![0.; result.state_count],
            &mut vec![0.; result.output_count()],
            &mut vec![0.; result.columns.len()],
        )?;
        Ok(result)
    }
    pub fn state_count(&self) -> usize {
        self.state_count
    }
    pub fn output_count(&self) -> usize {
        self.rows.len()
    }
    pub fn offsets(&self) -> &[usize] {
        &self.offsets
    }
    pub fn columns(&self) -> &[usize] {
        &self.columns
    }
    /// Fresh scalar polynomial response on finite signed trial coordinates.
    /// Duplicate physical-coordinate contributions are SUMMED before clients
    /// take magnitudes. State-zero derivatives never change the sparse support.
    pub fn evaluate(
        &self,
        y: &[f64],
        powers: &mut [f64],
        gradients: &mut [f64],
    ) -> Result<(), &'static str> {
        if y.len() != self.state_count
            || powers.len() != self.rows.len()
            || gradients.len() != self.columns.len()
            || y.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid fuel power response buffers/state");
        }
        powers.fill(0.);
        gradients.fill(0.);
        for (q, row) in self.rows.iter().enumerate() {
            let gradient = &mut gradients[self.offsets[q]..self.offsets[q + 1]];
            for (t, slots) in row.terms.iter().zip(&row.slots) {
                let (power, d0, d1) = match *t {
                    Term::Prompt {
                        n,
                        spent,
                        reference,
                        gain,
                    } => {
                        let fraction = (reference - y[spent]) / reference;
                        (
                            gain * fraction * y[n],
                            gain * fraction,
                            -gain * y[n] / reference,
                        )
                    }
                    Term::Spontaneous {
                        first,
                        second,
                        reference,
                        power,
                    } => {
                        let remaining = reference - y[first] - second.map_or(0., |i| y[i]);
                        (
                            power * (remaining / reference),
                            -power / reference,
                            -power / reference,
                        )
                    }
                    Term::Retained { energy, gain } => (gain * y[energy], gain, 0.),
                };
                powers[q] += power;
                if let Some(i) = slots[0] {
                    gradient[i] += d0;
                }
                if let Some(i) = slots[1] {
                    gradient[i] += d1;
                }
            }
        }
        if powers
            .iter()
            .chain(gradients.iter())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel power response");
        }
        Ok(())
    }
}

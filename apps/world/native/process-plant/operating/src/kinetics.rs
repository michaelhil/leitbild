//! Conventional coupled regional neutron kinetics with six delayed groups.
//!
//! Each region owns N and six C inventories, ordered [N, C1, ..., C6]. All
//! regions use the SAME extensive neutron-equivalent population normalization;
//! C is an effective delayed-neutron source inventory, not an isotope or heat
//! inventory. A density or independently normalized regional power amplitude
//! must first be converted by its physical mapping owner.
//!
//! For region i, with beta_i = sum_g beta_ig:
//!   N'_i = (rho_i - beta_i) / Lambda_i * N_i
//!          + sum_g lambda_ig * C_ig + S_i + incoming - outgoing
//!   C'_ig = beta_ig / Lambda_i * N_i - lambda_ig * C_ig.
//! Each directed edge contributes k_ij*N_i once negatively at i and once
//! positively at j. Thus internal transfers cancel in sum_i(N_i + sum_g C_ig).
//! Local rho owns local net generation/loss, including separately declared
//! external leakage; it must not also subtract an edge's internal transfer.
//! This regional rho is a local gain/loss parameter, not an independently
//! predicted local k_eff. The coefficient owner must justify the GLOBAL
//! coupled critical/period/rod/feedback response; generation time Lambda is
//! not interchangeable with neutron lifetime.
//!
//! Lambda is seconds; lambda and edge k are 1/s; rho and beta are dimensionless;
//! S is population/s. No coefficients, topology, thermal power conversion or
//! feedback law are supplied by default. Their physical applicability remains
//! the engineering/mapping owner's responsibility. Lambda, beta and lambda
//! are immutable within this compiled coefficient configuration. If the
//! selected physics needs their state dependence, the constitutive-input and
//! tangent interface must explicitly include it; it is not hidden here.
//!
//! Evaluation admits finite signed Newton states AND constitutive inputs.
//! validate_accepted_state and validate_accepted_inputs separately admit
//! nonnegative physical inventories/rates and the declared reactivity domain,
//! without clipping. The full tangent includes constitutive input directions;
//! its frozen-input state partial must
//! not be mistaken for the complete coupled plant Jacobian.

use std::collections::BTreeSet;
use std::fmt;

pub const DELAYED_GROUPS: usize = 6;
pub const STATES_PER_REGION: usize = 1 + DELAYED_GROUPS;

#[derive(Clone, Copy, Debug)]
pub struct ReactivityDomain {
    pub minimum: f64,
    pub maximum: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct RegionParameters {
    pub generation_time_s: f64,
    pub delayed_fractions: [f64; DELAYED_GROUPS],
    pub decay_constants_per_s: [f64; DELAYED_GROUPS],
    pub reactivity_domain: ReactivityDomain,
}

/// Topology only. The corresponding current rate is supplied in Inputs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Transfer {
    pub donor: usize,
    pub receiver: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct RegionInput {
    pub reactivity: f64,
    pub external_source_per_s: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Inputs<'a> {
    pub regions: &'a [RegionInput],
    pub transfer_rates_per_s: &'a [f64],
}

#[derive(Clone, Copy, Debug)]
pub struct RegionInputDirection {
    pub reactivity: f64,
    pub external_source_per_s: f64,
}

/// Directions may have either sign, unlike physical source/transfer rates.
#[derive(Clone, Copy, Debug)]
pub struct InputDirection<'a> {
    pub regions: &'a [RegionInputDirection],
    pub transfer_rates_per_s: &'a [f64],
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    EmptyModel,
    DimensionOverflow,
    InvalidParameter {
        region: usize,
        name: &'static str,
    },
    InvalidReactivityDomain {
        region: usize,
    },
    InvalidTransfer {
        edge: usize,
    },
    DuplicateTransfer {
        edge: usize,
    },
    Length {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    InvalidValue {
        field: &'static str,
        index: usize,
    },
    ReactivityOutsideDomain {
        region: usize,
    },
    NegativeAcceptedInventory {
        index: usize,
    },
    NonfiniteResult {
        index: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "regional kinetics: {self:?}")
    }
}

impl std::error::Error for Error {}

#[derive(Debug)]
struct CompiledRegion {
    inverse_generation_time: f64,
    total_delayed_fraction: f64,
    delayed_production_per_s: [f64; DELAYED_GROUPS],
    decay_constants_per_s: [f64; DELAYED_GROUPS],
    domain: ReactivityDomain,
}

#[derive(Debug)]
pub struct Model {
    regions: Vec<CompiledRegion>,
    transfers: Vec<Transfer>,
    dimension: usize,
    structural_state_jacobian_nonzeros: usize,
}

impl Model {
    /// Validate and compile immutable coefficients/topology once.
    pub fn new(regions: Vec<RegionParameters>, transfers: Vec<Transfer>) -> Result<Self, Error> {
        if regions.is_empty() {
            return Err(Error::EmptyModel);
        }
        let dimension = regions
            .len()
            .checked_mul(STATES_PER_REGION)
            .ok_or(Error::DimensionOverflow)?;
        // Seven diagonals, six N->C and six C->N entries per region, plus
        // one unique off-diagonal N->N entry per directed non-self edge.
        let structural_state_jacobian_nonzeros = regions
            .len()
            .checked_mul(19)
            .and_then(|n| n.checked_add(transfers.len()))
            .ok_or(Error::DimensionOverflow)?;
        let mut compiled = Vec::with_capacity(regions.len());
        for (i, p) in regions.iter().enumerate() {
            if !p.generation_time_s.is_finite()
                || p.generation_time_s <= 0.
                || !p.generation_time_s.recip().is_finite()
            {
                return Err(Error::InvalidParameter {
                    region: i,
                    name: "generation_time_s",
                });
            }
            let mut beta = 0.;
            for g in 0..DELAYED_GROUPS {
                if !p.delayed_fractions[g].is_finite() || p.delayed_fractions[g] < 0. {
                    return Err(Error::InvalidParameter {
                        region: i,
                        name: "delayed_fractions",
                    });
                }
                if !p.decay_constants_per_s[g].is_finite() || p.decay_constants_per_s[g] <= 0. {
                    return Err(Error::InvalidParameter {
                        region: i,
                        name: "decay_constants_per_s",
                    });
                }
                beta += p.delayed_fractions[g];
            }
            if !beta.is_finite() || beta >= 1. {
                return Err(Error::InvalidParameter {
                    region: i,
                    name: "total_delayed_fraction",
                });
            }
            let domain = p.reactivity_domain;
            if !domain.minimum.is_finite()
                || !domain.maximum.is_finite()
                || domain.minimum > domain.maximum
            {
                return Err(Error::InvalidReactivityDomain { region: i });
            }
            let inverse_generation_time = p.generation_time_s.recip();
            let delayed_production_per_s = p.delayed_fractions.map(|b| b * inverse_generation_time);
            if delayed_production_per_s.iter().any(|x| !x.is_finite()) {
                return Err(Error::InvalidParameter {
                    region: i,
                    name: "delayed_production_per_s",
                });
            }
            compiled.push(CompiledRegion {
                inverse_generation_time,
                total_delayed_fraction: beta,
                delayed_production_per_s,
                decay_constants_per_s: p.decay_constants_per_s,
                domain,
            });
        }
        let mut seen = BTreeSet::new();
        for (edge, t) in transfers.iter().enumerate() {
            if t.donor >= regions.len() || t.receiver >= regions.len() || t.donor == t.receiver {
                return Err(Error::InvalidTransfer { edge });
            }
            if !seen.insert((t.donor, t.receiver)) {
                return Err(Error::DuplicateTransfer { edge });
            }
        }
        Ok(Self {
            regions: compiled,
            transfers,
            dimension,
            structural_state_jacobian_nonzeros,
        })
    }

    pub fn region_count(&self) -> usize {
        self.regions.len()
    }
    pub fn state_dimension(&self) -> usize {
        self.dimension
    }
    pub fn transfer_count(&self) -> usize {
        self.transfers.len()
    }

    /// Structural state-state entries, not a count for the future full plant
    /// Jacobian. All 7R states are differential; this block has no constraints.
    pub fn structural_state_jacobian_nonzeros(&self) -> usize {
        self.structural_state_jacobian_nonzeros
    }

    pub fn validate_accepted_state(&self, state: &[f64]) -> Result<(), Error> {
        finite_slice("state", state, self.dimension)?;
        for (index, &v) in state.iter().enumerate() {
            if v < 0. {
                return Err(Error::NegativeAcceptedInventory { index });
            }
        }
        Ok(())
    }

    /// Admit physical forcing separately from finite signed Newton continuation.
    pub fn validate_accepted_inputs(&self, inputs: Inputs<'_>) -> Result<(), Error> {
        self.validate_trial_inputs(inputs)?;
        for (i, (r, input)) in self.regions.iter().zip(inputs.regions).enumerate() {
            if input.external_source_per_s < 0. {
                return Err(Error::InvalidValue {
                    field: "accepted source",
                    index: i,
                });
            }
            if input.reactivity < r.domain.minimum || input.reactivity > r.domain.maximum {
                return Err(Error::ReactivityOutsideDomain { region: i });
            }
        }
        for (index, &rate) in inputs.transfer_rates_per_s.iter().enumerate() {
            if rate < 0. {
                return Err(Error::InvalidValue {
                    field: "accepted transfer rate",
                    index,
                });
            }
        }
        Ok(())
    }

    /// RHS at a finite physical state or signed numerical trial. No allocation.
    pub fn rates(&self, state: &[f64], inputs: Inputs<'_>, out: &mut [f64]) -> Result<(), Error> {
        finite_slice("state", state, self.dimension)?;
        self.validate_trial_inputs(inputs)?;
        length("rates", out.len(), self.dimension)?;
        self.state_action_unchecked(inputs, state, out);
        for (i, input) in inputs.regions.iter().enumerate() {
            out[i * STATES_PER_REGION] += input.external_source_per_s;
        }
        finite_results(out)
    }

    /// Exact partial J_state*v with constitutive inputs frozen. The full joined
    /// thermal/rod/chemistry Jacobian must ALSO use their input sensitivities.
    pub fn state_jacobian_action(
        &self,
        inputs: Inputs<'_>,
        direction: &[f64],
        out: &mut [f64],
    ) -> Result<(), Error> {
        self.validate_trial_inputs(inputs)?;
        finite_slice("state direction", direction, self.dimension)?;
        length("Jacobian action", out.len(), self.dimension)?;
        self.state_action_unchecked(inputs, direction, out);
        finite_results(out)
    }

    /// Exact total directional derivative of rates with respect to state,
    /// reactivity, external source AND current transfer rates. This is the
    /// assembly port for state-dependent feedback/coupling, not a frozen-rho
    /// surrogate for the complete implicit plant Jacobian.
    pub fn directional_derivative(
        &self,
        state: &[f64],
        inputs: Inputs<'_>,
        state_direction: &[f64],
        input_direction: InputDirection<'_>,
        out: &mut [f64],
    ) -> Result<(), Error> {
        finite_slice("state", state, self.dimension)?;
        finite_slice("state direction", state_direction, self.dimension)?;
        self.validate_trial_inputs(inputs)?;
        length(
            "input direction",
            input_direction.regions.len(),
            self.regions.len(),
        )?;
        finite_slice(
            "transfer direction",
            input_direction.transfer_rates_per_s,
            self.transfers.len(),
        )?;
        for (i, d) in input_direction.regions.iter().enumerate() {
            if !d.reactivity.is_finite() || !d.external_source_per_s.is_finite() {
                return Err(Error::InvalidValue {
                    field: "input direction",
                    index: i,
                });
            }
        }
        length("directional derivative", out.len(), self.dimension)?;
        self.state_action_unchecked(inputs, state_direction, out);
        for (i, (r, d)) in self.regions.iter().zip(input_direction.regions).enumerate() {
            let row = i * STATES_PER_REGION;
            out[row] +=
                state[row] * r.inverse_generation_time * d.reactivity + d.external_source_per_s;
        }
        for (edge, d_rate) in self
            .transfers
            .iter()
            .zip(input_direction.transfer_rates_per_s)
        {
            let donor = edge.donor * STATES_PER_REGION;
            let receiver = edge.receiver * STATES_PER_REGION;
            let transfer = d_rate * state[donor];
            out[donor] -= transfer;
            out[receiver] += transfer;
        }
        finite_results(out)
    }

    fn validate_trial_inputs(&self, inputs: Inputs<'_>) -> Result<(), Error> {
        length("region inputs", inputs.regions.len(), self.regions.len())?;
        finite_slice(
            "transfer rates",
            inputs.transfer_rates_per_s,
            self.transfers.len(),
        )?;
        for (i, input) in inputs.regions.iter().enumerate() {
            if !input.reactivity.is_finite() || !input.external_source_per_s.is_finite() {
                return Err(Error::InvalidValue {
                    field: "region input",
                    index: i,
                });
            }
        }
        Ok(())
    }

    fn state_action_unchecked(&self, inputs: Inputs<'_>, values: &[f64], out: &mut [f64]) {
        for (i, (r, input)) in self.regions.iter().zip(inputs.regions).enumerate() {
            let row = i * STATES_PER_REGION;
            let n = values[row];
            out[row] =
                (input.reactivity - r.total_delayed_fraction) * r.inverse_generation_time * n;
            for g in 0..DELAYED_GROUPS {
                let delayed = r.decay_constants_per_s[g] * values[row + 1 + g];
                out[row] += delayed;
                out[row + 1 + g] = r.delayed_production_per_s[g] * n - delayed;
            }
        }
        for (edge, rate) in self.transfers.iter().zip(inputs.transfer_rates_per_s) {
            let donor = edge.donor * STATES_PER_REGION;
            let receiver = edge.receiver * STATES_PER_REGION;
            let transfer = rate * values[donor];
            out[donor] -= transfer;
            out[receiver] += transfer;
        }
    }
}

fn length(field: &'static str, actual: usize, expected: usize) -> Result<(), Error> {
    if actual != expected {
        Err(Error::Length {
            field,
            expected,
            actual,
        })
    } else {
        Ok(())
    }
}

fn finite_slice(field: &'static str, values: &[f64], expected: usize) -> Result<(), Error> {
    length(field, values.len(), expected)?;
    for (index, v) in values.iter().enumerate() {
        if !v.is_finite() {
            return Err(Error::InvalidValue { field, index });
        }
    }
    Ok(())
}

fn finite_results(values: &[f64]) -> Result<(), Error> {
    for (index, v) in values.iter().enumerate() {
        if !v.is_finite() {
            return Err(Error::NonfiniteResult { index });
        }
    }
    Ok(())
}

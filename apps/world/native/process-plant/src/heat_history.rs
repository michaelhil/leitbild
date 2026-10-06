//! Material-owned delayed-energy block with independent achieved event feeds.
//! Linear stores can be eliminated exactly from a BDF/Newton stage without
//! resetting their accepted physical history or lagging source feedback.
//! This does not calculate neutron flux, capture donors or thermal recipients.

#[derive(Clone, Copy, Debug)]
pub enum Feed {
    Fission,
    FertileCapture,
}
#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub feed: Feed,
    pub energy_per_event: f64,
    pub decay_rate: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Rates {
    pub fission: f64,
    pub fertile_capture: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct StageHeat {
    pub prompt: f64,
    pub delayed: f64,
    pub delayed_fission_tangent: f64,
    pub delayed_capture_tangent: f64,
    /// Prompt plus same-trial delayed fission sensitivity, J/event.
    pub total_fission_tangent: f64,
}
pub struct Kernel {
    groups: Vec<Group>,
    prompt_fission_energy: f64,
}
impl Kernel {
    pub fn new(groups: Vec<Group>, fission_energy: f64) -> Result<Self, String> {
        if groups.is_empty()
            || !fission_energy.is_finite()
            || fission_energy <= 0.
            || groups.iter().any(|g| {
                !g.energy_per_event.is_finite()
                    || g.energy_per_event < 0.
                    || !g.decay_rate.is_finite()
                    || g.decay_rate <= 0.
            })
        {
            return Err("Invalid delayed-energy coefficients".into());
        }
        let delayed: f64 = groups
            .iter()
            .filter(|g| matches!(g.feed, Feed::Fission))
            .map(|g| g.energy_per_event)
            .sum();
        let prompt_fission_energy = fission_energy - delayed;
        if !prompt_fission_energy.is_finite() || prompt_fission_energy <= 0. {
            return Err("Delayed fission reserves exhaust the fission event budget".into());
        }
        Ok(Self {
            groups,
            prompt_fission_energy,
        })
    }
    pub fn group_count(&self) -> usize {
        self.groups.len()
    }
    fn validate(&self, values: &[f64], rates: Rates) -> Result<(), String> {
        if values.len() != self.groups.len()
            || values.iter().any(|x| !x.is_finite())
            || !rates.fission.is_finite()
            || rates.fission < 0.
            || !rates.fertile_capture.is_finite()
            || rates.fertile_capture < 0.
        {
            return Err("Invalid history shape, stage data or event rates".into());
        }
        Ok(())
    }
    fn feed(g: &Group, rates: Rates) -> f64 {
        match g.feed {
            Feed::Fission => rates.fission,
            Feed::FertileCapture => rates.fertile_capture,
        }
    }
    /// Signed Newton trials are allowed; accepted material stores must be
    /// nonnegative. No per-stage allocation; caller owns all buffers.
    pub fn rhs_into(
        &self,
        stores: &[f64],
        rates: Rates,
        rhs: &mut [f64],
    ) -> Result<StageHeat, String> {
        self.validate(stores, rates)?;
        if rhs.len() != stores.len() {
            return Err("Invalid history RHS buffer".into());
        }
        let mut heat = StageHeat {
            prompt: self.prompt_fission_energy * rates.fission,
            total_fission_tangent: self.prompt_fission_energy,
            ..StageHeat::default()
        };
        for ((g, &e), r) in self.groups.iter().zip(stores).zip(rhs.iter_mut()) {
            let release = g.decay_rate * e;
            *r = g.energy_per_event * Self::feed(g, rates) - release;
            heat.delayed += release;
        }
        if !heat.prompt.is_finite()
            || !heat.delayed.is_finite()
            || rhs.iter().any(|x| !x.is_finite())
        {
            return Err("Unrepresentable delayed-energy RHS".into());
        }
        Ok(heat)
    }
    /// For the actual integrator stage E'=cj*E-history_rhs, solve
    /// (cj+lambda)*E=history_rhs+event_energy*achieved_feed. General order
    /// history_rhs is supplied by the solver, not a fabricated Euler history.
    /// Tangents give same-trial source coupling in the reduced heat equation.
    pub fn stage_into(
        &self,
        cj: f64,
        history_rhs: &[f64],
        rates: Rates,
        stores: &mut [f64],
    ) -> Result<StageHeat, String> {
        self.validate(history_rhs, rates)?;
        if !cj.is_finite() || cj <= 0. || stores.len() != history_rhs.len() {
            return Err("Invalid delayed-energy stage coefficient/buffer".into());
        }
        let mut heat = StageHeat {
            prompt: self.prompt_fission_energy * rates.fission,
            total_fission_tangent: self.prompt_fission_energy,
            ..StageHeat::default()
        };
        for ((g, &b), e) in self.groups.iter().zip(history_rhs).zip(stores.iter_mut()) {
            let denominator = cj + g.decay_rate;
            if !denominator.is_finite() || denominator <= 0. {
                return Err("Unrepresentable delayed-energy stage denominator".into());
            }
            *e = (b + g.energy_per_event * Self::feed(g, rates)) / denominator;
            heat.delayed += g.decay_rate * *e;
            let tangent = g.decay_rate * g.energy_per_event / denominator;
            match g.feed {
                Feed::Fission => heat.delayed_fission_tangent += tangent,
                Feed::FertileCapture => heat.delayed_capture_tangent += tangent,
            }
        }
        heat.total_fission_tangent += heat.delayed_fission_tangent;
        if ![
            heat.prompt,
            heat.delayed,
            heat.delayed_fission_tangent,
            heat.delayed_capture_tangent,
            heat.total_fission_tangent,
        ]
        .iter()
        .all(|x| x.is_finite())
            || stores.iter().any(|x| !x.is_finite())
        {
            return Err("Unrepresentable delayed-energy stage".into());
        }
        Ok(heat)
    }
}

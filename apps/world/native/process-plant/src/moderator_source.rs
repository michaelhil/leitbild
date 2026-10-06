//! PRIMARY native H2O and MOBILE liquid B10 reactions only. Finite targets and
//! binding emission, not retained/body absorbers, photon deposition or a reactor.
use std::sync::Arc;
pub const GROUPS: usize = 7;
#[derive(Clone, Debug)]
pub struct ModeratorLaw {
    pub absorption: [f64; GROUPS],        // reference moderator m^-1
    pub scatter: [[f64; GROUPS]; GROUPS], // from -> to
    pub speed: [f64; GROUPS],
    pub boron_sigma: [f64; GROUPS],  // selected microscopic m^2
    pub reference_density: f64,      // kg/m^3
    pub hydrogen_emission: [f64; 2], // charged/photon J per capture
    pub boron_emission: [f64; 2],
}
#[derive(Clone, Copy, Debug)]
pub struct Intersection {
    pub region: usize,
    pub volume: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Stocks {
    pub water_mass: f64,    // native H2O ONLY, kg; vapor may moderate
    pub liquid_volume: f64, // actual liquid occupation, m^3
    pub hydrogen_target: f64,
    pub hydrogen_product: f64,
    pub mobile_boron10: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RowCoefficients {
    /// All independent stock partials require positive water/reference/liquid.
    /// Dry/vapor-only origins do not supply an unrestricted mobile-B tangent.
    pub partials_available: bool,
    pub hydrogen: [f64; GROUPS],
    pub boron: [f64; GROUPS],
    pub d_hydrogen_d_mass: [f64; GROUPS],
    pub d_hydrogen_d_target: [f64; GROUPS],
    pub d_hydrogen_d_product: [f64; GROUPS],
    pub d_boron_d_atoms: [f64; GROUPS],
    pub scatter_scale: f64,
    pub d_scatter_scale_d_mass: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Events {
    pub hydrogen: f64,
    pub boron: f64,
    pub emitted_charged: f64, // W: charge budget, NOT deposited plant heat
    pub emitted_photon: f64,
}
impl Events {
    /// H target/product, mobile B10 target/product, in atom/s. Products and
    /// consumed targets receive this SAME event, never a re-evaluated count.
    pub fn target_rates(&self) -> [f64; 4] {
        [-self.hydrogen, self.hydrogen, -self.boron, self.boron]
    }
}
pub struct Workspace {
    coefficients: Vec<f64>, // 7x7 blocks by region, no dense global matrix
    rows: Vec<RowCoefficients>,
    owner: Arc<()>,
    valid: bool,
}
impl Workspace {
    /// Known Vec element payload only, not allocator/solver/model memory.
    pub fn buffer_bytes(&self) -> usize {
        self.coefficients.len() * std::mem::size_of::<f64>()
            + self.rows.len() * std::mem::size_of::<RowCoefficients>()
    }
    pub fn coefficients(&self) -> Result<&[f64], &'static str> {
        if self.valid {
            Ok(&self.coefficients)
        } else {
            Err("Unupdated moderator workspace")
        }
    }
    pub fn rows(&self) -> Result<&[RowCoefficients], &'static str> {
        if self.valid {
            Ok(&self.rows)
        } else {
            Err("Unupdated moderator workspace")
        }
    }
}
pub struct ModeratorModel {
    law: ModeratorLaw,
    volumes: Vec<f64>,
    intersections: Vec<Intersection>,
    owner: Arc<()>,
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}
fn nonnegative(v: f64) -> bool {
    v.is_finite() && v >= 0.
}
impl ModeratorModel {
    pub fn new(
        law: ModeratorLaw,
        volumes: Vec<f64>,
        intersections: Vec<Intersection>,
    ) -> Result<Self, &'static str> {
        if volumes.is_empty()
            || !volumes.iter().all(|v| positive(*v))
            || !positive(law.reference_density)
            || !law.speed.iter().all(|v| positive(*v))
            || !law
                .absorption
                .iter()
                .chain(law.scatter.iter().flatten())
                .chain(law.boron_sigma.iter())
                .chain(law.hydrogen_emission.iter())
                .chain(law.boron_emission.iter())
                .all(|v| nonnegative(*v))
        {
            return Err("Invalid owned moderator law/region volume");
        }
        let mut covered = vec![0.; volumes.len()];
        for e in &intersections {
            if e.region >= volumes.len() || !positive(e.volume) {
                return Err("Invalid actual water/source intersection");
            }
            covered[e.region] += e.volume;
        }
        if covered
            .iter()
            .zip(&volumes)
            .any(|(a, v)| *a > *v * (1. + 3e-11))
        {
            return Err("Water support exceeds region volume");
        }
        Ok(Self {
            law,
            volumes,
            intersections,
            owner: Arc::new(()),
        })
    }
    pub fn law(&self) -> &ModeratorLaw {
        &self.law
    }
    pub fn volumes(&self) -> &[f64] {
        &self.volumes
    }
    pub fn intersections(&self) -> &[Intersection] {
        &self.intersections
    }
    /// Contributor collision sum includes full scatter rows, including self.
    pub fn collision_into(
        &self,
        work: &Workspace,
        collision: &mut [[f64; GROUPS]],
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || !work.valid
            || collision.len() != self.volumes.len()
        {
            return Err("Invalid moderator collision workspace/output");
        }
        collision.fill([0.; GROUPS]);
        for (e, r) in self.intersections.iter().zip(&work.rows) {
            for g in 0..GROUPS {
                collision[e.region][g] += (r.hydrogen[g] + r.boron[g]) / self.law.speed[g]
                    + r.scatter_scale * self.law.scatter[g].iter().sum::<f64>();
            }
        }
        if collision.iter().flatten().any(|v| !nonnegative(*v)) {
            return Err("Nonfinite moderator collision candidate");
        }
        Ok(())
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            coefficients: vec![0.; self.volumes.len() * GROUPS * GROUPS],
            rows: vec![RowCoefficients::default(); self.intersections.len()],
            owner: Arc::clone(&self.owner),
            valid: false,
        }
    }
    /// Rebuild the local source from actual same-trial stocks. Advection and
    /// phase transfer must supply these amounts; this function never seeds them.
    pub fn update(&self, stocks: &[Stocks], work: &mut Workspace) -> Result<(), &'static str> {
        work.valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || stocks.len() != self.intersections.len()
            || work.rows.len() != stocks.len()
            || work.coefficients.len() != self.volumes.len() * 49
        {
            return Err("Wrong moderator workspace/stock incidence");
        }
        work.coefficients.fill(0.);
        for (i, (s, e)) in stocks.iter().zip(&self.intersections).enumerate() {
            if ![
                s.water_mass,
                s.liquid_volume,
                s.hydrogen_target,
                s.hydrogen_product,
                s.mobile_boron10,
            ]
            .iter()
            .all(|v| nonnegative(*v))
                || s.liquid_volume > e.volume * (1. + 3e-11)
                || (s.mobile_boron10 > 0. && !(s.liquid_volume > 0. && s.water_mass > 0.))
                || (s.water_mass > 0. && !(s.hydrogen_target + s.hydrogen_product > 0.))
                || (s.water_mass == 0.
                    && (s.hydrogen_target > 0. || s.hydrogen_product > 0. || s.liquid_volume > 0.))
            {
                return Err("Invalid native water/finite target/liquid B10 support");
            }
            let V = self.volumes[e.region];
            let denominator = self.law.reference_density * V;
            let reference = s.hydrogen_target + s.hydrogen_product;
            if !reference.is_finite() {
                return Err("Nonfinite hydrogen reference");
            }
            let remaining = if reference > 0. {
                s.hydrogen_target / reference
            } else {
                0.
            };
            let scale = s.water_mass / denominator;
            let mut r = RowCoefficients {
                partials_available: s.water_mass > 0. && reference > 0. && s.liquid_volume > 0.,
                scatter_scale: scale,
                d_scatter_scale_d_mass: 1. / denominator,
                ..Default::default()
            };
            for g in 0..GROUPS {
                let a = self.law.speed[g] * self.law.absorption[g];
                r.hydrogen[g] = a * scale * remaining;
                r.boron[g] = self.law.speed[g] * self.law.boron_sigma[g] * s.mobile_boron10 / V;
                r.d_hydrogen_d_mass[g] = a / denominator * remaining;
                // Dividing in this order avoids squaring a large atom count.
                if reference > 0. {
                    r.d_hydrogen_d_target[g] =
                        a * scale * (s.hydrogen_product / reference) / reference;
                    r.d_hydrogen_d_product[g] = -a * scale * remaining / reference;
                }
                r.d_boron_d_atoms[g] = self.law.speed[g] * self.law.boron_sigma[g] / V;
                for h in 0..GROUPS {
                    if h == g {
                        continue;
                    } // self-scattering neither creates nor destroys a neutron
                    let transfer = self.law.speed[g] * self.law.scatter[g][h] * scale;
                    work.coefficients[e.region * 49 + h * 7 + g] += transfer;
                    work.coefficients[e.region * 49 + g * 7 + g] -= transfer;
                }
                work.coefficients[e.region * 49 + g * 7 + g] -= r.hydrogen[g] + r.boron[g];
            }
            if r.hydrogen
                .iter()
                .chain(r.boron.iter())
                .chain(r.d_hydrogen_d_mass.iter())
                .chain(r.d_hydrogen_d_target.iter())
                .chain(r.d_hydrogen_d_product.iter())
                .chain(r.d_boron_d_atoms.iter())
                .any(|v| !v.is_finite())
            {
                return Err("Nonfinite moderator response");
            }
            work.rows[i] = r;
        }
        if !work.coefficients.iter().all(|v| v.is_finite()) {
            return Err("Nonfinite assembled moderator coefficients");
        }
        work.valid = true;
        Ok(())
    }
    /// Ndot contribution and row event budgets. Signed finite neutron trials are
    /// allowed for a solver; accepted amounts remain the integrator's obligation.
    pub fn apply(
        &self,
        work: &Workspace,
        neutrons: &[f64],
        rate: &mut [f64],
        events: &mut [Events],
    ) -> Result<(), &'static str> {
        if !work.valid
            || !Arc::ptr_eq(&self.owner, &work.owner)
            || neutrons.len() != self.volumes.len() * 7
            || rate.len() != neutrons.len()
            || events.len() != self.intersections.len()
            || !neutrons.iter().all(|v| v.is_finite())
        {
            return Err("Invalid/unupdated moderator source buffers");
        }
        rate.fill(0.);
        for region in 0..self.volumes.len() {
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    rate[region * 7 + h] +=
                        work.coefficients[region * 49 + h * 7 + g] * neutrons[region * 7 + g];
                }
            }
        }
        for (i, (e, r)) in self.intersections.iter().zip(&work.rows).enumerate() {
            let H = (0..GROUPS)
                .map(|g| r.hydrogen[g] * neutrons[e.region * 7 + g])
                .sum::<f64>();
            let B = (0..GROUPS)
                .map(|g| r.boron[g] * neutrons[e.region * 7 + g])
                .sum::<f64>();
            events[i] = Events {
                hydrogen: H,
                boron: B,
                emitted_charged: H * self.law.hydrogen_emission[0] + B * self.law.boron_emission[0],
                emitted_photon: H * self.law.hydrogen_emission[1] + B * self.law.boron_emission[1],
            };
        }
        if rate
            .iter()
            .chain(
                events
                    .iter()
                    .flat_map(|e| [&e.hydrogen, &e.boron, &e.emitted_charged, &e.emitted_photon]),
            )
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite moderator rates/events");
        }
        Ok(())
    }
}

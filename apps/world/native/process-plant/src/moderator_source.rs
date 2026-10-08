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
/// One physical owner's homogeneous material state. Bulk cavity volume is
/// distinct from liquid occupation: steam may moderate without carrying B10.
#[derive(Clone, Copy, Debug, Default)]
pub struct Bulk {
    volume: f64,
    density: f64,
    remaining: f64,
    product_fraction: f64,
    reference: f64,
    boron_density: f64,
    partials_available: bool,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct BulkDirection {
    density: f64,
    remaining: f64,
    boron_density: f64,
}
impl Bulk {
    pub fn new(s: Stocks, volume: f64) -> Result<Self, &'static str> {
        let reference = s.hydrogen_target + s.hydrogen_product;
        if !nonnegative(volume)
            || ![
                s.water_mass,
                s.liquid_volume,
                s.hydrogen_target,
                s.mobile_boron10,
            ]
            .iter()
            .all(|v| nonnegative(*v))
            || !s.hydrogen_product.is_finite()
            || !reference.is_finite()
            || s.liquid_volume > volume * (1. + 3e-11)
            || (s.mobile_boron10 > 0. && !(s.liquid_volume > 0. && s.water_mass > 0.))
            || (s.water_mass > 0. && !(reference > 0. && volume > 0.))
            || (s.water_mass == 0.
                && (s.hydrogen_target != 0. || s.hydrogen_product != 0. || s.liquid_volume != 0.))
        {
            return Err("Invalid native water/finite target/liquid B10 support");
        }
        if volume == 0. {
            return Ok(Self::default());
        }
        let result = Self {
            volume,
            density: s.water_mass / volume,
            remaining: if reference > 0. {
                s.hydrogen_target / reference
            } else {
                0.
            },
            product_fraction: if reference > 0. {
                s.hydrogen_product / reference
            } else {
                0.
            },
            reference,
            boron_density: s.mobile_boron10 / volume,
            partials_available: s.water_mass > 0. && reference > 0. && s.liquid_volume > 0.,
        };
        if ![
            result.density,
            result.remaining,
            result.product_fraction,
            result.boron_density,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return Err("Nonfinite native bulk material response");
        }
        Ok(result)
    }
    pub fn direction(&self, ds: Stocks, dvolume: f64) -> Result<BulkDirection, &'static str> {
        if ![
            ds.water_mass,
            ds.liquid_volume,
            ds.hydrogen_target,
            ds.hydrogen_product,
            ds.mobile_boron10,
            dvolume,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return Err("Nonfinite native bulk material direction");
        }
        if self.volume == 0. {
            if [
                ds.water_mass,
                ds.liquid_volume,
                ds.hydrogen_target,
                ds.hydrogen_product,
                ds.mobile_boron10,
                dvolume,
            ]
            .iter()
            .any(|v| *v != 0.)
            {
                return Err("No native material tangent at an empty zero-volume owner");
            }
            return Ok(BulkDirection::default());
        }
        let result = BulkDirection {
            density: (ds.water_mass - self.density * dvolume) / self.volume,
            remaining: if self.reference > 0. {
                (self.product_fraction * ds.hydrogen_target - self.remaining * ds.hydrogen_product)
                    / self.reference
            } else {
                0.
            },
            boron_density: (ds.mobile_boron10 - self.boron_density * dvolume) / self.volume,
        };
        if ![result.density, result.remaining, result.boron_density]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("Nonfinite native bulk material tangent");
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn law() -> ModeratorLaw {
        ModeratorLaw {
            absorption: [0.03; GROUPS],
            scatter: [[0.08; GROUPS]; GROUPS],
            speed: [7.; GROUPS],
            boron_sigma: [0.002; GROUPS],
            reference_density: 1000.,
            hydrogen_emission: [0.1, 0.2],
            boron_emission: [0.3, 0.4],
        }
    }
    fn zero() -> Stocks {
        Stocks {
            water_mass: 0.,
            liquid_volume: 0.,
            hydrogen_target: 0.,
            hydrogen_product: 0.,
            mobile_boron10: 0.,
        }
    }
    fn shift(s: Stocks, ds: Stocks, h: f64) -> Stocks {
        Stocks {
            water_mass: s.water_mass + h * ds.water_mass,
            liquid_volume: s.liquid_volume + h * ds.liquid_volume,
            hydrogen_target: s.hydrogen_target + h * ds.hydrogen_target,
            hydrogen_product: s.hydrogen_product + h * ds.hydrogen_product,
            mobile_boron10: s.mobile_boron10 + h * ds.mobile_boron10,
        }
    }
    fn close(a: f64, b: f64) {
        assert!(
            (a - b).abs() <= 2e-9 * (1. + a.abs().max(b.abs())),
            "{a:e} != {b:e}"
        );
    }
    #[test]
    fn moving_bulk_and_patch_material_direction_includes_partial_liquid_and_vapor() {
        let m = ModeratorModel::new(
            law(),
            vec![1.],
            vec![Intersection {
                region: 0,
                volume: 0.25,
            }],
        )
        .unwrap();
        let mut w = m.workspace();
        let ds = Stocks {
            water_mass: 1.4,
            liquid_volume: 0.,
            hydrogen_target: 3.5,
            hydrogen_product: -0.7,
            mobile_boron10: 0.,
        };
        for liquid in [0., 0.5] {
            let s = Stocks {
                water_mass: 850.,
                liquid_volume: liquid,
                hydrogen_target: 1300.,
                hydrogen_product: 200.,
                mobile_boron10: if liquid > 0. { 9. } else { 0. },
            };
            let ds = Stocks {
                mobile_boron10: if liquid > 0. { 0.04 } else { 0. },
                ..ds
            };
            let bulk = Bulk::new(s, 2.).unwrap();
            m.update_projected(&[zero()], &[0.25], &[bulk], &[Some(0)], &mut w)
                .unwrap();
            assert_eq!(w.rows().unwrap()[0].partials_available, liquid > 0.);
            let exact = m.row_direction(0, ds, 0.08, -0.03, &w).unwrap();
            let h = 1e-5;
            let mut rows = Vec::new();
            for sign in [-1., 1.] {
                let owner = Bulk::new(shift(s, ds, sign * h), 2. + sign * h * 0.08).unwrap();
                m.update_projected(
                    &[zero()],
                    &[0.25 - sign * h * 0.03],
                    &[owner],
                    &[Some(0)],
                    &mut w,
                )
                .unwrap();
                rows.push(w.rows().unwrap()[0]);
            }
            close(
                exact.scatter_scale,
                (rows[1].scatter_scale - rows[0].scatter_scale) / (2. * h),
            );
            for g in 0..GROUPS {
                close(
                    exact.hydrogen[g],
                    (rows[1].hydrogen[g] - rows[0].hydrogen[g]) / (2. * h),
                );
                close(
                    exact.boron[g],
                    (rows[1].boron[g] - rows[0].boron[g]) / (2. * h),
                );
            }
        }
    }
    #[test]
    fn constant_patch_uses_owner_concentration_without_fraction_times_amount_roundtrip() {
        // The actual failing UPPER patch and its three current bulk volumes.
        // Binary M=rho*V roundtrips are not universally exact; discriminate
        // owner-first arithmetic from a second projected stock/composition path.
        let patch = 0.154592341150225382;
        let rho = 998.2969533801312;
        let m = ModeratorModel::new(
            law(),
            vec![1.],
            vec![Intersection {
                region: 0,
                volume: patch,
            }],
        )
        .unwrap();
        let mut w = m.workspace();
        for v in [42.79271796614326, 42.79271478617437, 42.792721146112136] {
            let mass = rho * v;
            let s = Stocks {
                water_mass: mass,
                liquid_volume: v,
                hydrogen_target: 6.6857e25 * mass * (1. - 1e-6),
                hydrogen_product: 6.6857e25 * mass * 1e-6,
                mobile_boron10: 2.217e22 * mass,
            };
            let bulk = Bulk::new(s, v).unwrap();
            m.update_projected(&[zero()], &[patch], &[bulk], &[Some(0)], &mut w)
                .unwrap();
            let r = w.rows().unwrap()[0];
            let scale = ((mass / v) / 1000.) * patch;
            assert_eq!(r.scatter_scale.to_bits(), scale.to_bits());
            let remaining = s.hydrogen_target / (s.hydrogen_target + s.hydrogen_product);
            for g in 0..GROUPS {
                assert_eq!(
                    r.hydrogen[g].to_bits(),
                    (7. * 0.03 * scale * remaining).to_bits()
                );
                let expected = 7. * 0.002 * (s.mobile_boron10 / v) * patch;
                assert_eq!(r.boron[g].to_bits(), expected.to_bits());
            }
            assert!(
                (r.scatter_scale - (rho / 1000.) * patch).abs()
                    <= 2. * f64::EPSILON * r.scatter_scale
            );
        }
    }
    #[test]
    fn empty_owner_and_nonfinite_derived_material_responses_refuse_without_floors() {
        for hp in [-1., 1.] {
            assert!(
                Bulk::new(
                    Stocks {
                        hydrogen_product: hp,
                        ..zero()
                    },
                    0.
                )
                .is_err()
            );
        }
        assert!(
            Bulk::new(
                Stocks {
                    hydrogen_target: 1.,
                    hydrogen_product: -1.,
                    ..zero()
                },
                1.
            )
            .is_err()
        );
        let empty = Bulk::new(zero(), 0.).unwrap();
        assert!(empty.direction(zero(), 0.).is_ok());
        assert!(empty.direction(zero(), 1.).is_err());
        assert!(
            empty
                .direction(
                    Stocks {
                        water_mass: 1.,
                        ..zero()
                    },
                    0.
                )
                .is_err()
        );
        let s = Stocks {
            water_mass: 1.,
            hydrogen_target: 110.,
            hydrogen_product: -10.,
            ..zero()
        };
        assert!(Bulk::new(s, 1.).is_ok()); // Signed progress with a positive donor remains valid.
        assert!(Bulk::new(s, 1e-320).is_err()); // Derived density overflow, no arbitrary V floor.
        let tiny = Bulk::new(s, 0.1).unwrap();
        assert!(
            tiny.direction(
                Stocks {
                    water_mass: f64::MAX,
                    ..zero()
                },
                0.
            )
            .is_err()
        );
        let m = ModeratorModel::new(
            law(),
            vec![1.],
            vec![Intersection {
                region: 0,
                volume: 0.25,
            }],
        )
        .unwrap();
        let mut w = m.workspace();
        let bulk = Bulk::new(
            Stocks {
                water_mass: 1000.,
                hydrogen_target: 100.,
                ..zero()
            },
            1.,
        )
        .unwrap();
        m.update_projected(&[zero()], &[0.25], &[bulk], &[Some(0)], &mut w)
            .unwrap();
        assert!(m.row_direction(0, zero(), 0., f64::MAX, &w).is_err());
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RowDirection {
    pub hydrogen: [f64; GROUPS],
    pub boron: [f64; GROUPS],
    pub scatter_scale: f64,
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
    covered: Vec<f64>,
    coefficients: Vec<f64>, // 7x7 blocks by region, no dense global matrix
    rows: Vec<RowCoefficients>,
    bulk: Vec<Bulk>,
    patch_volumes: Vec<f64>,
    owner: Arc<()>,
    valid: bool,
}
impl Workspace {
    /// Known Vec element payload only, not allocator/solver/model memory.
    pub fn buffer_bytes(&self) -> usize {
        self.coefficients.len() * std::mem::size_of::<f64>()
            + self.rows.len() * std::mem::size_of::<RowCoefficients>()
            + self.covered.len() * 8
            + self.bulk.len() * std::mem::size_of::<Bulk>()
            + self.patch_volumes.len() * 8
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
            if e.region >= volumes.len() || !nonnegative(e.volume) {
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
            covered: vec![0.; self.volumes.len()],
            coefficients: vec![0.; self.volumes.len() * GROUPS * GROUPS],
            rows: vec![RowCoefficients::default(); self.intersections.len()],
            bulk: vec![Bulk::default(); self.intersections.len()],
            patch_volumes: vec![0.; self.intersections.len()],
            owner: Arc::clone(&self.owner),
            valid: false,
        }
    }
    /// Rebuild the local source from actual same-trial stocks. Advection and
    /// phase transfer must supply these amounts; this function never seeds them.
    pub fn update(&self, stocks: &[Stocks], work: &mut Workspace) -> Result<(), &'static str> {
        self.update_geometry(stocks, None, None, work)
    }
    pub fn update_with_volumes(
        &self,
        stocks: &[Stocks],
        volumes: &[f64],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.update_geometry(stocks, Some(volumes), None, work)
    }
    /// Prepare material ratios once per physical external owner, then apply
    /// actual source-patch volumes. No fraction×amount×ratio round trip.
    pub fn update_projected(
        &self,
        stocks: &[Stocks],
        volumes: &[f64],
        owners: &[Bulk],
        row_owners: &[Option<usize>],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        if row_owners.len() != self.intersections.len()
            || row_owners.iter().flatten().any(|&i| i >= owners.len())
        {
            work.valid = false;
            return Err("Invalid moderator physical owner mapping");
        }
        self.update_geometry(stocks, Some(volumes), Some((owners, row_owners)), work)
    }
    pub fn row_direction(
        &self,
        row: usize,
        ds: Stocks,
        downer_volume: f64,
        dpatch_volume: f64,
        work: &Workspace,
    ) -> Result<RowDirection, &'static str> {
        if !work.valid
            || !Arc::ptr_eq(&self.owner, &work.owner)
            || row >= work.rows.len()
            || !dpatch_volume.is_finite()
        {
            return Err("Invalid moderator row direction stage");
        }
        let b = work.bulk[row];
        let db = b.direction(ds, downer_volume)?;
        let region_volume = self.volumes[self.intersections[row].region];
        let patch = work.patch_volumes[row];
        let scale = (b.density / self.law.reference_density) * (patch / region_volume);
        let dscale = (db.density * patch + b.density * dpatch_volume)
            / (self.law.reference_density * region_volume);
        let mut result = RowDirection {
            scatter_scale: dscale,
            ..Default::default()
        };
        for g in 0..GROUPS {
            result.hydrogen[g] = self.law.speed[g]
                * self.law.absorption[g]
                * (dscale * b.remaining + scale * db.remaining);
            result.boron[g] = self.law.speed[g] * self.law.boron_sigma[g] / region_volume
                * (db.boron_density * patch + b.boron_density * dpatch_volume);
        }
        if !result.scatter_scale.is_finite()
            || result
                .hydrogen
                .iter()
                .chain(&result.boron)
                .any(|v| !v.is_finite())
        {
            return Err("Nonfinite moderator row tangent");
        }
        Ok(result)
    }
    fn update_geometry(
        &self,
        stocks: &[Stocks],
        volumes: Option<&[f64]>,
        projection: Option<(&[Bulk], &[Option<usize>])>,
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        work.valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || stocks.len() != self.intersections.len()
            || work.rows.len() != stocks.len()
            || work.coefficients.len() != self.volumes.len() * 49
            || volumes.is_some_and(|v| {
                v.len() != self.intersections.len() || v.iter().any(|x| !nonnegative(*x))
            })
        {
            return Err("Wrong moderator workspace/stock incidence");
        }
        work.covered.fill(0.);
        for (i, e) in self.intersections.iter().enumerate() {
            work.covered[e.region] += volumes.map_or(e.volume, |v| v[i]);
        }
        if work
            .covered
            .iter()
            .zip(&self.volumes)
            .any(|(a, v)| !a.is_finite() || *a > *v * (1. + 3e-11))
        {
            return Err("Current water support exceeds source region");
        }
        work.coefficients.fill(0.);
        for (i, (s, e)) in stocks.iter().zip(&self.intersections).enumerate() {
            let patch = volumes.map_or(e.volume, |v| v[i]);
            let bulk = match projection
                .and_then(|(owners, mapping)| mapping[i].map(|index| owners[index]))
            {
                Some(b) => b,
                None => Bulk::new(*s, patch)?,
            };
            let region_volume = self.volumes[e.region];
            let scale = (bulk.density / self.law.reference_density) * (patch / region_volume);
            let mass_partial = if bulk.volume > 0. {
                patch / (self.law.reference_density * region_volume * bulk.volume)
            } else {
                0.
            };
            let mut r = RowCoefficients {
                partials_available: bulk.partials_available && patch > 0.,
                scatter_scale: scale,
                d_scatter_scale_d_mass: mass_partial,
                ..Default::default()
            };
            for g in 0..GROUPS {
                let a = self.law.speed[g] * self.law.absorption[g];
                r.hydrogen[g] = a * scale * bulk.remaining;
                r.boron[g] = self.law.speed[g]
                    * self.law.boron_sigma[g]
                    * bulk.boron_density
                    * (patch / region_volume);
                r.d_hydrogen_d_mass[g] = a * mass_partial * bulk.remaining;
                // Dividing in this order avoids squaring a large atom count.
                if bulk.reference > 0. {
                    r.d_hydrogen_d_target[g] = a * scale * bulk.product_fraction / bulk.reference;
                    r.d_hydrogen_d_product[g] = -a * scale * bulk.remaining / bulk.reference;
                }
                r.d_boron_d_atoms[g] = if bulk.volume > 0. {
                    self.law.speed[g] * self.law.boron_sigma[g] * (patch / region_volume)
                        / bulk.volume
                } else {
                    0.
                };
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
            if !r.scatter_scale.is_finite()
                || !r.d_scatter_scale_d_mass.is_finite()
                || r.hydrogen
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
            work.bulk[i] = bulk;
            work.patch_volumes[i] = patch;
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

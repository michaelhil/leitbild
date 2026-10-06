//! Selected converter capture-binding energy paths, not a gamma solver or an
//! advanced thermal state. Geometry/materials come from the actual owner. The
//! collection electronics never set the charged-particle energy partition.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub film_thickness: f64,
    pub film_density: f64,
    pub film_mu_en: f64,
    pub carrier_wall: f64,
    pub thimble_wall: f64,
    pub steel_density: f64,
    pub steel_mu_en: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct LiquidPath {
    pub density: f64,
    pub mu_en: f64,
    pub chord: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Rates {
    pub collector: f64,
    pub helium: f64,
    pub wall: f64,
    pub liquid: f64,
    pub export: f64,
    pub emitted: f64,
}
pub struct Model {
    photon_collector: f64,
    photon_wall: f64,
    photon_leaving_wall: f64,
    charged_j: f64,
    photon_j: f64,
}
fn absorption(density: f64, mu_en: f64, length: f64) -> Result<f64, &'static str> {
    if [density, mu_en, length].iter().any(|v| !v.is_finite() || *v < 0.) {
        return Err("Invalid actual photon path");
    }
    let tau = density * mu_en * length;
    if !tau.is_finite() { return Err("Unrepresentable photon optical depth"); }
    Ok(-(-tau).exp_m1())
}
impl Model {
    pub fn new(g: Geometry, charged_j: f64, photon_j: f64) -> Result<Self, &'static str> {
        if [g.film_thickness, g.film_density, g.carrier_wall, g.thimble_wall,
            g.steel_density, charged_j, photon_j].iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err("Missing finite converter geometry/binding emission");
        }
        let film = absorption(g.film_density, g.film_mu_en, g.film_thickness)?;
        let carrier = absorption(g.steel_density, g.steel_mu_en, 2. * g.carrier_wall)?;
        let wall = absorption(g.steel_density, g.steel_mu_en, g.thimble_wall)?;
        // One inward and one outward diffuse path share the film's remainder.
        // Only the inward path crosses the carrier twice. Both cross WALL.3.
        let through = (1. - film) * (0.5 * (1. - carrier) + 0.5);
        Ok(Self { photon_collector: film + (1. - film) * 0.5 * carrier,
            photon_wall: through * wall, photon_leaving_wall: through * (1. - wall),
            charged_j, photon_j })
    }
    /// Signed event-rate trials remain linear and cannot become accepted
    /// physical histories. `None` means an explicitly absent liquid contact,
    /// never an unresolved or missing recipient implicitly treated as dry.
    pub fn apply(&self, captures: f64, escaped_charged_events: f64,
        liquid: Option<LiquidPath>) -> Result<Rates, &'static str> {
        if !captures.is_finite() || !escaped_charged_events.is_finite() {
            return Err("Nonfinite converter energy event trial");
        }
        let liquid_absorption = if let Some(q) = liquid {
            if q.density <= 0. || q.chord <= 0. { return Err("Absent liquid passed as wet contact"); }
            absorption(q.density, q.mu_en, q.chord)?
        } else { 0. };
        let photon = captures * self.photon_j;
        let beyond_wall = photon * self.photon_leaving_wall;
        let rates = Rates {
            collector: (captures - escaped_charged_events) * self.charged_j + photon * self.photon_collector,
            helium: escaped_charged_events * self.charged_j,
            wall: photon * self.photon_wall,
            liquid: beyond_wall * liquid_absorption,
            export: beyond_wall * (1. - liquid_absorption),
            emitted: captures * (self.charged_j + self.photon_j),
        };
        if [rates.collector, rates.helium, rates.wall, rates.liquid, rates.export, rates.emitted]
            .iter().any(|v| !v.is_finite()) { return Err("Unrepresentable converter energy rate"); }
        Ok(rates)
    }
}

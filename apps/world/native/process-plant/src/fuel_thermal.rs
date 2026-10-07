//! Fixed-prepared-geometry radial fuel/clad and shared sealed-helium energy.
//!
//! Laws are owned by reference-design-fuel-materials.ts and LD-01's
//! radial-energy-transient/phase-dependent-heat-transfer owners. This cold,
//! fully wet sensible branch has no axial conduction, moving geometry, phase,
//! damage, source normalization or maintained thermal receiver. The caller
//! owns differential E and algebraic T: E=e(T), E'=the returned heat rate.
//! Supplied liquid properties must come from the same current admitted native
//! water state. Pressure acts through those properties, not a second gap-work
//! term: the sealed prepared gas volume is fixed.
use std::sync::Arc;

const PI: f64 = std::f64::consts::PI;
const SB: f64 = 5.670374419e-8;
const BTU: f64 = 1055.05585262 / 3600. / 0.3048 * 1.8;
const DATUM: f64 = 300.;
const CP_T: [f64; 15] = [
    300., 400., 640., 1090., 1093., 1113., 1133., 1153., 1173., 1193., 1213., 1233., 1248., 2098.,
    2099.,
];
const CP_C: [f64; 15] = [
    281., 302., 331., 375., 502., 590., 615., 719., 816., 770., 619., 469., 356., 356., 356.,
];

// System libm on the selected Darwin/Linux native platforms. This evaluates
// the analytic cold conductivity primitive, not an authored erf approximation.
#[link(name = "m")]
unsafe extern "C" {
    fn erfc(x: f64) -> f64;
}

#[derive(Clone, Copy, Debug)]
pub struct Helium {
    pub volume_m3: f64,
    pub nr_j_k: f64,
    /// Positive accommodation retained at the actual prepared temperature.
    pub accommodation: f64,
}
#[derive(Clone, Debug)]
pub struct Band {
    pub fuel_radius_m: f64,
    pub clad_inner_radius_m: f64,
    pub clad_outer_radius_m: f64,
    pub length_m: f64,
    pub rods: usize,
    pub fuel_masses_kg: Vec<f64>,
    pub clad_masses_kg: Vec<f64>,
    pub helium: usize,
    pub water: usize,
    /// Flow and area refer to the SAME actual hydraulic passage. They may
    /// describe the aggregate MAIN passage shared by identical FA contacts.
    pub flow_area_m2: f64,
    pub hydraulic_diameter_m: f64,
    /// Explicit prepared grey selections, not spectral emissivity or an
    /// inherited nominal radiation-omission certificate.
    pub fuel_emissivity: f64,
    pub clad_emissivity: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Water {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    /// Actual same-pressure saturation boundary, used only to refuse trials
    /// outside this deliberately preboiling sensible-liquid branch.
    pub saturation_temperature_k: f64,
    pub mass_flow_kg_s: f64,
    pub conductivity_w_m_k: f64,
    pub viscosity_pa_s: f64,
    pub cp_j_kg_k: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct WaterDirection {
    pub temperature_k: f64,
    pub mass_flow_kg_s: f64,
    pub conductivity_w_m_k: f64,
    pub viscosity_pa_s: f64,
    pub cp_j_kg_k: f64,
}
struct CompiledBand {
    input: Band,
    first: usize,
    radial: Vec<(usize, usize, f64, bool)>,
    fuel_surface: usize,
    clad_inner: usize,
    clad_outer: usize,
    fuel_area: f64,
    wall_area: f64,
    radiation: f64,
}
pub struct Model {
    bands: Vec<CompiledBand>,
    helium: Vec<Helium>,
    solids: usize,
    waters: usize,
    owner: Arc<()>,
}
pub struct Workspace {
    energy: Vec<f64>,
    capacity: Vec<f64>,
    heat: Vec<f64>,
    wall: Vec<f64>,
    energy_direction: Vec<f64>,
    heat_direction: Vec<f64>,
    wall_direction: Vec<f64>,
    temperature: Vec<f64>,
    water: Vec<Water>,
    owner: Arc<()>,
    valid: bool,
    direction_valid: bool,
}
impl Workspace {
    pub fn energies(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.energy)
    }
    pub fn capacities(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.capacity)
    }
    pub fn heat_rates(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.heat)
    }
    /// Positive means heat ENTERS the actual finite water recipient.
    pub fn wall_rates(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.wall)
    }
    pub fn energy_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.energy_direction)
    }
    pub fn heat_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.heat_direction)
    }
    pub fn wall_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.wall_direction)
    }
    fn check(&self) -> Result<(), &'static str> {
        if self.valid {
            Ok(())
        } else {
            Err("Unprepared fuel thermal workspace")
        }
    }
    fn check_direction(&self) -> Result<(), &'static str> {
        self.check()?;
        if self.direction_valid {
            Ok(())
        } else {
            Err("Unprepared fuel thermal direction")
        }
    }
}
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.
}
fn fuel_cp(t: f64) -> f64 {
    let z = 535.285 / t;
    296.7 * z * z * z.exp() / z.exp_m1().powi(2)
        + 0.0243 * t
        + 8.745e7 * 1.577e5 / (8.3143 * t * t) * (-1.577e5 / (8.3143 * t)).exp()
}
/// Stable difference of the owned caloric primitive at its 300 K datum.
fn fuel_energy(t: f64) -> f64 {
    let a = 535.285 / DATUM;
    let d = 535.285 * (DATUM - t) / (t * DATUM);
    let c = 1.577e5 / 8.3143;
    -296.7 * 535.285 * a.exp() * d.exp_m1() / ((535.285 / t).exp_m1() * a.exp_m1())
        + 0.0243 * (t - DATUM) * (t + DATUM) / 2.
        + 8.745e7 * (-c / DATUM).exp() * (c * (t - DATUM) / (t * DATUM)).exp_m1()
}
fn clad_cp(t: f64) -> f64 {
    if t < DATUM {
        return 281. + 0.21 * (t - DATUM);
    }
    let i = CP_T
        .windows(2)
        .position(|w| t <= w[1])
        .unwrap_or(CP_T.len() - 2);
    CP_C[i] + (CP_C[i + 1] - CP_C[i]) / (CP_T[i + 1] - CP_T[i]) * (t - CP_T[i])
}
fn clad_energy(t: f64) -> f64 {
    if t < DATUM {
        return 281. * (t - DATUM) + 0.105 * (t - DATUM).powi(2);
    }
    let mut out = 0.;
    for i in 0..CP_T.len() - 1 {
        if t > CP_T[i] {
            let dt = t.min(CP_T[i + 1]) - CP_T[i];
            out += dt * (CP_C[i] + 0.5 * (CP_C[i + 1] - CP_C[i]) / (CP_T[i + 1] - CP_T[i]) * dt);
        }
    }
    out
}
fn hot_k(t: f64) -> f64 {
    BTU * ((2335. / (t + 190.85)).max(1.1038) + 0.007027 * (0.001867 * (t - 273.15)).exp())
}
fn cold_k(t: f64) -> f64 {
    let z = t / 1000.;
    100. / (7.5408 + 17.692 * z + 3.6142 * z * z) + 6400. * z.powf(-2.5) * (-16.35 / z).exp()
}
fn fuel_k(t: f64) -> f64 {
    if t < 500. {
        cold_k(t) * hot_k(500.) / cold_k(500.)
    } else {
        hot_k(t)
    }
}
fn clad_k(t: f64) -> f64 {
    7.51 + 0.0209 * t - 1.45e-5 * t * t + 7.67e-9 * t * t * t
}
fn cold_increment(a: f64, b: f64) -> f64 {
    let dz = (b - a) / 1000.;
    let s = (17.692_f64.powi(2) - 4. * 7.5408 * 3.6142).sqrt();
    let r = 2. * 3.6142 * (a / 1000.) + 17.692;
    let rational =
        100000. / s * ((2. * 3.6142 * dz / (r - s)).ln_1p() - (2. * 3.6142 * dz / (r + s)).ln_1p());
    let exponential = if (b - a).abs() <= 0.001 * a.min(b) {
        // Stable local increment of the tiny exponential term: four-point
        // Gauss integration over <=0.1% T avoids subtracting adjacent erfc
        // values. This is evaluation of the same primitive, not a fitted law.
        let mid = (a + b) / 2.;
        let half = (b - a) / 2.;
        let mut sum = 0.;
        for (x, w) in [
            (0.3399810435848563, 0.6521451548625461),
            (0.8611363115940526, 0.34785484513745385),
        ] {
            for sign in [-1., 1.] {
                let z = (mid + sign * half * x) / 1000.;
                sum += w * 6400. * z.powf(-2.5) * (-16.35 / z).exp();
            }
        }
        half * sum
    } else {
        let primitive = |t: f64| {
            let u = (16.35 / (t / 1000.)).sqrt();
            6.4e6 / 16.35_f64.powf(1.5)
                * (u * (-u * u).exp() + 0.5 * PI.sqrt() * unsafe { erfc(u) })
        };
        primitive(b) - primitive(a)
    };
    (rational + exponential) * hot_k(500.) / cold_k(500.)
}
fn fuel_increment(a: f64, b: f64) -> f64 {
    if a == b {
        return 0.;
    }
    if b < a {
        return -fuel_increment(b, a);
    }
    if a < 500. {
        return cold_increment(a, b.min(500.))
            + if b > 500. {
                fuel_increment(500., b)
            } else {
                0.
            };
    }
    let switch = 2335. / 1.1038 - 190.85;
    let phonon = if a < switch {
        2335. * ((b.min(switch) - a) / (a + 190.85)).ln_1p() + 1.1038 * (b - switch).max(0.)
    } else {
        1.1038 * (b - a)
    };
    BTU * (phonon
        + 0.007027 / 0.001867 * (0.001867 * (a - 273.15)).exp() * (0.001867 * (b - a)).exp_m1())
}
fn clad_increment(a: f64, b: f64) -> f64 {
    let d = b - a;
    d * (7.51 + 0.0209 * (b + a) / 2. - 1.45e-5 * (b * b + a * b + a * a) / 3.
        + 7.67e-9 * (b + a) * (b * b + a * a) / 4.)
}
fn wall(b: &Band, t: f64, w: Water, dt: f64, dw: WaterDirection) -> (f64, f64) {
    // Fixed base-state/generalized Newton branch: equality selects heating
    // for the Pr exponent and the conduction floor for max(Nu). At either
    // switch this is a selected linearization, not a two-sided derivative.
    let re = w.mass_flow_kg_s.abs() * b.hydraulic_diameter_m / (b.flow_area_m2 * w.viscosity_pa_s);
    let pr = w.cp_j_kg_k * w.viscosity_pa_s / w.conductivity_w_m_k;
    let exponent = if t >= w.temperature_k { 0.4 } else { 0.3 };
    let db = 0.023 * re.powf(0.8) * pr.powf(exponent);
    let nu = db.max(7.86);
    let h = nu * w.conductivity_w_m_k / b.hydraulic_diameter_m;
    let dlog = if db > 7.86 {
        0.8 * (dw.mass_flow_kg_s / w.mass_flow_kg_s - dw.viscosity_pa_s / w.viscosity_pa_s)
            + exponent
                * (dw.cp_j_kg_k / w.cp_j_kg_k + dw.viscosity_pa_s / w.viscosity_pa_s
                    - dw.conductivity_w_m_k / w.conductivity_w_m_k)
    } else {
        0.
    };
    let dh = h * (dw.conductivity_w_m_k / w.conductivity_w_m_k + dlog);
    (
        h * (t - w.temperature_k),
        dh * (t - w.temperature_k) + h * (dt - dw.temperature_k),
    )
}

impl Model {
    pub fn new(
        bands: Vec<Band>,
        helium: Vec<Helium>,
        water_count: usize,
    ) -> Result<Self, &'static str> {
        if bands.is_empty()
            || helium.is_empty()
            || water_count == 0
            || helium.iter().any(|h| {
                !positive(h.volume_m3)
                    || !positive(h.nr_j_k)
                    || !positive(h.accommodation)
                    || h.accommodation > 1.
            })
        {
            return Err("Invalid fuel thermal owners");
        }
        let mut used = vec![false; helium.len()];
        let mut compiled = Vec::with_capacity(bands.len());
        let mut solids = 0usize;
        for b in bands {
            if ![
                b.fuel_radius_m,
                b.clad_inner_radius_m,
                b.clad_outer_radius_m,
                b.length_m,
                b.flow_area_m2,
                b.hydraulic_diameter_m,
                b.fuel_emissivity,
                b.clad_emissivity,
            ]
            .iter()
            .all(|&x| positive(x))
                || b.clad_inner_radius_m <= b.fuel_radius_m
                || b.clad_outer_radius_m <= b.clad_inner_radius_m
                || b.rods == 0
                || b.fuel_emissivity > 1.
                || b.clad_emissivity > 1.
                || b.helium >= helium.len()
                || b.water >= water_count
                || b.fuel_masses_kg.len() < 2
                || b.clad_masses_kg.len() < 2
                || !b
                    .fuel_masses_kg
                    .iter()
                    .chain(&b.clad_masses_kg)
                    .all(|&m| positive(m))
            {
                return Err("Invalid prepared radial band");
            }
            used[b.helium] = true;
            let first = solids;
            let nf = b.fuel_masses_kg.len();
            let nc = b.clad_masses_kg.len();
            solids = solids
                .checked_add(nf)
                .and_then(|x| x.checked_add(nc))
                .ok_or("Fuel thermal size overflow")?;
            let length = b.length_m * b.rods as f64;
            let mut radial = Vec::with_capacity(nf + nc - 2);
            for (base, n, lo, hi, fuel) in [
                (first, nf, 0., b.fuel_radius_m, true),
                (
                    first + nf,
                    nc,
                    b.clad_inner_radius_m,
                    b.clad_outer_radius_m,
                    false,
                ),
            ] {
                let dr = (hi - lo) / (n - 1) as f64;
                for i in 0..n - 1 {
                    radial.push((
                        base + i,
                        base + i + 1,
                        2. * PI * length * (lo + (i as f64 + 0.5) * dr) / dr,
                        fuel,
                    ));
                }
            }
            let af = 2. * PI * b.fuel_radius_m * length;
            let ac = 2. * PI * b.clad_inner_radius_m * length;
            let radiation = SB
                / ((1. / b.fuel_emissivity - 1.) / af
                    + 1. / af
                    + (1. / b.clad_emissivity - 1.) / ac);
            let wall_area = 2. * PI * b.clad_outer_radius_m * length;
            if radial.iter().any(|e| !positive(e.2)) || !positive(radiation) || !positive(wall_area)
            {
                return Err("Unrepresentable prepared thermal geometry");
            }
            compiled.push(CompiledBand {
                fuel_surface: first + nf - 1,
                clad_inner: first + nf,
                clad_outer: solids - 1,
                input: b,
                first,
                radial,
                fuel_area: af,
                wall_area,
                radiation,
            });
        }
        if used.iter().any(|&x| !x) || solids.checked_add(helium.len()).is_none() {
            return Err("Unowned or oversized shared helium");
        }
        Ok(Self {
            bands: compiled,
            helium,
            solids,
            waters: water_count,
            owner: Arc::new(()),
        })
    }
    pub fn node_count(&self) -> usize {
        self.solids + self.helium.len()
    }
    pub fn band_count(&self) -> usize {
        self.bands.len()
    }
    pub fn water_count(&self) -> usize {
        self.waters
    }
    pub fn band_water(&self, band: usize) -> usize {
        self.bands[band].input.water
    }
    pub fn fuel_node_count(&self) -> usize {
        self.bands
            .iter()
            .map(|b| b.input.fuel_masses_kg.len())
            .sum()
    }
    pub fn is_fuel_node(&self, row: usize) -> bool {
        self.bands
            .iter()
            .any(|b| (b.first..b.clad_inner).contains(&row))
    }
    /// Reference mass of the actual mapped fuel caloric owner, not cladding
    /// or helium and not a second independently authored source mass.
    pub fn fuel_mass_kg(&self, row: usize) -> Option<f64> {
        self.bands
            .iter()
            .find(|b| (b.first..b.clad_inner).contains(&row))
            .map(|b| b.input.fuel_masses_kg[row - b.first])
    }
    pub fn helium_row(&self, h: usize) -> usize {
        self.solids + h
    }
    pub fn fuel_rows(&self, b: usize) -> std::ops::Range<usize> {
        let b = &self.bands[b];
        b.first..b.clad_inner
    }
    pub fn clad_rows(&self, b: usize) -> std::ops::Range<usize> {
        let b = &self.bands[b];
        b.clad_inner..b.clad_outer + 1
    }
    pub fn workspace(&self) -> Workspace {
        let n = self.node_count();
        Workspace {
            energy: vec![0.; n],
            capacity: vec![0.; n],
            heat: vec![0.; n],
            wall: vec![0.; self.band_count()],
            energy_direction: vec![0.; n],
            heat_direction: vec![0.; n],
            wall_direction: vec![0.; self.band_count()],
            temperature: vec![0.; n],
            water: vec![Water::default(); self.waters],
            owner: self.owner.clone(),
            valid: false,
            direction_valid: false,
        }
    }
    fn gap(&self, b: &CompiledBand, t: f64) -> (f64, f64) {
        let h = self.helium[b.input.helium];
        let p = h.nr_j_k * t / h.volume_m3;
        let k = 1.314e-3 * (1.8 * t).powf(0.668) * BTU;
        let jump = 0.3048 * 2.0358e-5 * (k / BTU) * t.sqrt()
            / ((p / 6894.757293168) * h.accommodation / 4.003_f64.sqrt());
        let gap = b.input.clad_inner_radius_m - b.input.fuel_radius_m;
        let denom = gap + 1.845 * jump;
        let g = 2. * b.fuel_area * k / denom;
        (g, g / t * (0.668 - 1.845 * 0.168 * jump / denom))
    }
    pub fn evaluate_into(
        &self,
        temperature: &[f64],
        deposited_w: &[f64],
        water: &[Water],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.valid = false;
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || temperature.len() != self.node_count()
            || deposited_w.len() != self.node_count()
            || water.len() != self.waters
            || temperature
                .iter()
                .chain(deposited_w)
                .any(|x| !x.is_finite())
            || water.iter().any(|q| {
                ![
                    q.pressure_pa,
                    q.temperature_k,
                    q.saturation_temperature_k,
                    q.conductivity_w_m_k,
                    q.viscosity_pa_s,
                    q.cp_j_kg_k,
                ]
                .iter()
                .all(|&v| positive(v))
                    || !q.mass_flow_kg_s.is_finite()
                    || q.temperature_k >= q.saturation_temperature_k
            })
        {
            return Err("Invalid fuel thermal trial/workspace");
        }
        w.heat.copy_from_slice(deposited_w);
        for (band_index, b) in self.bands.iter().enumerate() {
            if temperature[b.clad_outer] >= water[b.input.water].saturation_temperature_k {
                return Err("Clad wall outside selected preboiling liquid branch");
            }
            for (range, mass, fuel) in [
                (self.fuel_rows_index(b), &b.input.fuel_masses_kg, true),
                (
                    b.clad_inner..b.clad_outer + 1,
                    &b.input.clad_masses_kg,
                    false,
                ),
            ] {
                for (i, &m) in range.zip(mass) {
                    let t = temperature[i];
                    if t < 290. || t > if fuel { 2000. } else { 1800. } {
                        return Err("Fuel/clad temperature outside selected material domain");
                    }
                    w.energy[i] = m * if fuel { fuel_energy(t) } else { clad_energy(t) };
                    w.capacity[i] = m * if fuel { fuel_cp(t) } else { clad_cp(t) };
                }
            }
            for &(a, c, g, fuel) in &b.radial {
                let q = g * if fuel {
                    fuel_increment(temperature[c], temperature[a])
                } else {
                    clad_increment(temperature[c], temperature[a])
                };
                w.heat[a] -= q;
                w.heat[c] += q;
            }
            let f = b.fuel_surface;
            let c = b.clad_inner;
            let h = self.helium_row(b.input.helium);
            let tg = temperature[h];
            if tg < 290. || tg > 2000. {
                return Err("Helium temperature outside selected cold package domain");
            }
            let (g, _) = self.gap(b, tg);
            let qf = g * (temperature[f] - tg);
            let qc = g * (tg - temperature[c]);
            w.heat[f] -= qf;
            w.heat[h] += qf - qc;
            w.heat[c] += qc;
            let tf = temperature[f];
            let tc = temperature[c];
            let qr = b.radiation * (tf - tc) * (tf + tc) * (tf * tf + tc * tc);
            w.heat[f] -= qr;
            w.heat[c] += qr;
            let qwall = b.wall_area
                * wall(
                    &b.input,
                    temperature[b.clad_outer],
                    water[b.input.water],
                    0.,
                    WaterDirection::default(),
                )
                .0;
            w.wall[band_index] = qwall;
            w.heat[b.clad_outer] -= qwall;
        }
        for (j, h) in self.helium.iter().enumerate() {
            let i = self.helium_row(j);
            w.capacity[i] = 1.5 * h.nr_j_k;
            w.energy[i] = w.capacity[i] * temperature[i];
        }
        if w.energy
            .iter()
            .chain(&w.heat)
            .chain(&w.wall)
            .any(|x| !x.is_finite())
            || !w.capacity.iter().all(|&x| positive(x))
        {
            return Err("Unrepresentable fuel thermal transaction");
        }
        w.temperature.copy_from_slice(temperature);
        w.water.copy_from_slice(water);
        w.valid = true;
        Ok(())
    }
    fn fuel_rows_index(&self, b: &CompiledBand) -> std::ops::Range<usize> {
        b.first..b.clad_inner
    }
    /// Additive sparse entries of d(heat)/d(T), holding current supplied
    /// water properties/flows and deposition fixed. Includes every local
    /// contact, also structurally present entries whose current value is zero.
    /// This is the thermal block only, not a complete coupled Jacobian.
    /// On error the caller must discard any already emitted candidate entries.
    pub fn visit_heat_derivatives(
        &self,
        w: &Workspace,
        mut emit: impl FnMut(usize, usize, f64),
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &w.owner) || !w.valid {
            return Err("Thermal derivative assembly requires owned current preparation");
        }
        let mut transfer = |a: usize, c: usize, col: usize, dq: f64| {
            if !dq.is_finite() {
                return Err("Unrepresentable thermal contact derivative");
            }
            emit(a, col, -dq);
            emit(c, col, dq);
            Ok(())
        };
        for b in &self.bands {
            for &(a, c, g, fuel) in &b.radial {
                let k = if fuel { fuel_k } else { clad_k };
                transfer(a, c, a, g * k(w.temperature[a]))?;
                transfer(a, c, c, -g * k(w.temperature[c]))?;
            }
            let f = b.fuel_surface;
            let c = b.clad_inner;
            let h = self.helium_row(b.input.helium);
            let tg = w.temperature[h];
            let (g, dg) = self.gap(b, tg);
            transfer(f, h, f, g)?;
            transfer(f, h, h, dg * (w.temperature[f] - tg) - g)?;
            transfer(h, c, h, dg * (tg - w.temperature[c]) + g)?;
            transfer(h, c, c, -g)?;
            transfer(f, c, f, 4. * b.radiation * w.temperature[f].powi(3))?;
            transfer(f, c, c, -4. * b.radiation * w.temperature[c].powi(3))?;
        }
        // End the reciprocal-transfer borrow before emitting one-sided wall
        // debits. The matching recipient derivative belongs to the join.
        drop(transfer);
        for b in &self.bands {
            let dq = b.wall_area
                * wall(
                    &b.input,
                    w.temperature[b.clad_outer],
                    w.water[b.input.water],
                    1.,
                    WaterDirection::default(),
                )
                .1;
            if !dq.is_finite() {
                return Err("Unrepresentable thermal wall derivative");
            }
            emit(b.clad_outer, b.clad_outer, -dq);
        }
        Ok(())
    }
    pub fn jvp_into(
        &self,
        temperature: &[f64],
        deposited_w: &[f64],
        water: &[WaterDirection],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || temperature.len() != self.node_count()
            || deposited_w.len() != self.node_count()
            || water.len() != self.waters
            || temperature
                .iter()
                .chain(deposited_w)
                .any(|x| !x.is_finite())
            || water.iter().any(|q| {
                [
                    q.temperature_k,
                    q.mass_flow_kg_s,
                    q.conductivity_w_m_k,
                    q.viscosity_pa_s,
                    q.cp_j_kg_k,
                ]
                .iter()
                .any(|x| !x.is_finite())
            })
        {
            return Err("Invalid fuel thermal direction/workspace");
        }
        w.heat_direction.copy_from_slice(deposited_w);
        for i in 0..self.node_count() {
            w.energy_direction[i] = w.capacity[i] * temperature[i];
        }
        for (j, b) in self.bands.iter().enumerate() {
            for &(a, c, g, fuel) in &b.radial {
                let k = if fuel { fuel_k } else { clad_k };
                let dq = g
                    * (k(w.temperature[a]) * temperature[a] - k(w.temperature[c]) * temperature[c]);
                w.heat_direction[a] -= dq;
                w.heat_direction[c] += dq;
            }
            let f = b.fuel_surface;
            let c = b.clad_inner;
            let h = self.helium_row(b.input.helium);
            let tg = w.temperature[h];
            let (g, dg) = self.gap(b, tg);
            let dqf = g * (temperature[f] - temperature[h])
                + dg * temperature[h] * (w.temperature[f] - tg);
            let dqc = g * (temperature[h] - temperature[c])
                + dg * temperature[h] * (tg - w.temperature[c]);
            w.heat_direction[f] -= dqf;
            w.heat_direction[h] += dqf - dqc;
            w.heat_direction[c] += dqc;
            let dqr = 4.
                * b.radiation
                * (w.temperature[f].powi(3) * temperature[f]
                    - w.temperature[c].powi(3) * temperature[c]);
            w.heat_direction[f] -= dqr;
            w.heat_direction[c] += dqr;
            let dq = b.wall_area
                * wall(
                    &b.input,
                    w.temperature[b.clad_outer],
                    w.water[b.input.water],
                    temperature[b.clad_outer],
                    water[b.input.water],
                )
                .1;
            w.wall_direction[j] = dq;
            w.heat_direction[b.clad_outer] -= dq;
        }
        if w.energy_direction
            .iter()
            .chain(&w.heat_direction)
            .chain(&w.wall_direction)
            .any(|x| !x.is_finite())
        {
            return Err("Unrepresentable fuel thermal direction");
        }
        w.direction_valid = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(a: f64, b: f64, rel: f64, abs: f64) {
        assert!(
            (a - b).abs() <= abs + rel * a.abs().max(b.abs()),
            "{a:e} != {b:e}"
        );
    }
    fn band(h: usize, water: usize, nf: usize, nc: usize) -> Band {
        // Test-only radial apparatus; masses follow the actual CV construction.
        let rf = 0.004;
        let ri = 0.0041;
        let ro = 0.0047;
        let rods = 264;
        let masses = |lo: f64, hi: f64, nodes: usize, rho: f64| {
            let dr = (hi - lo) / (nodes - 1) as f64;
            (0..nodes)
                .map(|i| {
                    let a = if i == 0 {
                        lo
                    } else {
                        lo + (i as f64 - 0.5) * dr
                    };
                    let b = if i + 1 == nodes {
                        hi
                    } else {
                        lo + (i as f64 + 0.5) * dr
                    };
                    PI * (b * b - a * a) * rods as f64 * rho
                })
                .collect()
        };
        Band {
            fuel_radius_m: rf,
            clad_inner_radius_m: ri,
            clad_outer_radius_m: ro,
            length_m: 1.,
            rods,
            fuel_masses_kg: masses(0., rf, nf, 10412.),
            clad_masses_kg: masses(ri, ro, nc, 6500.),
            helium: h,
            water,
            flow_area_m2: 9.,
            hydraulic_diameter_m: 0.012,
            fuel_emissivity: 0.7,
            clad_emissivity: 0.7,
        }
    }
    fn helium() -> Helium {
        Helium {
            volume_m3: 0.0058,
            nr_j_k: 38.666666666666664,
            accommodation: 0.425 - 0.00023 * 300.,
        }
    }
    fn water(t: f64, flow: f64) -> Water {
        Water {
            pressure_pa: 1e7,
            saturation_temperature_k: 584.15,
            temperature_k: t,
            mass_flow_kg_s: flow,
            conductivity_w_m_k: 0.64,
            viscosity_pa_s: 0.0002,
            cp_j_kg_k: 4500.,
        }
    }
    fn model() -> Model {
        Model::new(vec![band(0, 0, 3, 3), band(0, 1, 3, 3)], vec![helium()], 2).unwrap()
    }
    #[test]
    fn material_primitives_and_stable_adjacent_temperature_increments() {
        for t in [290.001, 299., 300., 400., 499.99, 500., 1000., 1799., 1999.] {
            let d = 1e-3;
            close(
                (fuel_energy(t + d) - fuel_energy(t - d)) / (2. * d),
                fuel_cp(t),
                3e-8,
                1e-8,
            );
            if t < 1800. {
                // Cp is continuous at table knots but its slope changes.
                // The one-sided quadratic derivative stays in one segment;
                // central differencing across a knot has an O(step) bias.
                let h = 0.01;
                close(
                    (-3. * clad_energy(t) + 4. * clad_energy(t + h) - clad_energy(t + 2. * h))
                        / (2. * h),
                    clad_cp(t),
                    3e-8,
                    1e-8,
                );
            }
        }
        assert_eq!(fuel_energy(300.), 0.);
        assert_eq!(clad_energy(300.), 0.);
        assert!(fuel_energy(290.) < 0. && clad_energy(290.) < 0.);
        for a in [290., 300., 499.99, 500., 1200., 1950.] {
            let b = a + 1e-10;
            close(fuel_increment(a, b) / (b - a), fuel_k(a), 2e-12, 1e-12);
            close(fuel_increment(b, a), -fuel_increment(a, b), 0., 0.);
            assert_eq!(fuel_increment(a, a), 0.);
        }
        for (a, b) in [(290., 500.), (499.9, 500.1), (500., 1800.), (1900., 2000.)] {
            // Independent composite Simpson integration of conductivity itself.
            let n = 8000;
            let d = (b - a) / n as f64;
            let mut s = fuel_k(a) + fuel_k(b);
            for i in 1..n {
                s += if i % 2 == 0 { 2. } else { 4. } * fuel_k(a + i as f64 * d);
            }
            close(fuel_increment(a, b), s * d / 3., 2e-10, 1e-10);
        }
        let a: f64 = 300.;
        let b = f64::from_bits(a.to_bits() + 1);
        assert!(fuel_energy(b) > 0.);
        close(fuel_energy(b) / (b - a), fuel_cp(a), 2e-15, 1e-12);
    }
    #[test]
    fn zero_signed_heat_and_finite_shared_gas_are_not_a_thermostat() {
        let m = model();
        let n = m.node_count();
        let h = m.helium_row(0);
        let mut w = m.workspace();
        m.evaluate_into(
            &vec![300.; n],
            &vec![0.; n],
            &[water(300., 0.), water(300., 0.)],
            &mut w,
        )
        .unwrap();
        assert!(w.heat_rates().unwrap().iter().all(|&q| q == 0.));
        assert_eq!(w.energies().unwrap()[h], 1.5 * helium().nr_j_k * 300.);
        assert_eq!(w.capacities().unwrap()[h], 1.5 * helium().nr_j_k);
        assert!(w.energies().unwrap()[..h].iter().all(|&q| q == 0.));
        let mut t = vec![300.; n];
        for i in m.clad_rows(0) {
            t[i] = 310.;
        }
        m.evaluate_into(
            &t,
            &vec![0.; n],
            &[water(310., 0.), water(300., 0.)],
            &mut w,
        )
        .unwrap();
        // Warming clad cannot instantaneously cool fuel through a negative
        // eliminated-gas cross-capacity. The finite shared gas actually warms.
        assert!(w.heat_rates().unwrap()[h] > 0.);
        assert!(w.heat_rates().unwrap()[m.fuel_rows(0).end - 1] > 0.);
        assert_eq!(w.heat_rates().unwrap()[m.fuel_rows(1).end - 1], 0.);
        close(
            w.heat_rates().unwrap().iter().sum::<f64>()
                + w.wall_rates().unwrap().iter().sum::<f64>(),
            0.,
            0.,
            1e-9,
        );
        t.fill(300.);
        m.evaluate_into(
            &t,
            &vec![0.; n],
            &[water(310., 0.), water(290., 0.)],
            &mut w,
        )
        .unwrap();
        assert!(w.wall_rates().unwrap()[0] < 0. && w.wall_rates().unwrap()[1] > 0.);
    }
    #[test]
    fn same_trial_full_column_heat_and_caloric_jvp() {
        let m = model();
        let n = m.node_count();
        let mut w = m.workspace();
        let t: Vec<_> = (0..n).map(|i| 550. - i as f64 * 2.).collect();
        let dep: Vec<_> = (0..n).map(|i| i as f64 * 0.01).collect();
        let waters = [water(480., 5000.), water(490., -5000.)];
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        close(
            w.heat_rates().unwrap().iter().sum::<f64>()
                + w.wall_rates().unwrap().iter().sum::<f64>(),
            dep.iter().sum(),
            0.,
            1e-7,
        );
        for col in 0..n {
            let mut dt = vec![0.; n];
            dt[col] = 1.;
            m.jvp_into(&dt, &vec![0.; n], &[WaterDirection::default(); 2], &mut w)
                .unwrap();
            let analytic = w.heat_jvp().unwrap().to_vec();
            let energy = w.energy_jvp().unwrap().to_vec();
            let walls = w.wall_jvp().unwrap().to_vec();
            let eps = 1e-3;
            let mut plus = t.clone();
            let mut minus = t.clone();
            plus[col] += eps;
            minus[col] -= eps;
            let mut wp = m.workspace();
            let mut wm = m.workspace();
            m.evaluate_into(&plus, &dep, &waters, &mut wp).unwrap();
            m.evaluate_into(&minus, &dep, &waters, &mut wm).unwrap();
            for i in 0..n {
                close(
                    analytic[i],
                    (wp.heat_rates().unwrap()[i] - wm.heat_rates().unwrap()[i]) / (2. * eps),
                    2e-7,
                    2e-6,
                );
                close(
                    energy[i],
                    (wp.energies().unwrap()[i] - wm.energies().unwrap()[i]) / (2. * eps),
                    2e-8,
                    1e-5,
                );
            }
            for i in 0..2 {
                close(
                    walls[i],
                    (wp.wall_rates().unwrap()[i] - wm.wall_rates().unwrap()[i]) / (2. * eps),
                    2e-7,
                    2e-6,
                );
            }
        }
        let dw = WaterDirection {
            temperature_k: 0.3,
            mass_flow_kg_s: 2.,
            conductivity_w_m_k: 0.001,
            viscosity_pa_s: 1e-7,
            cp_j_kg_k: 0.5,
        };
        m.jvp_into(&vec![0.; n], &vec![0.; n], &[dw, dw], &mut w)
            .unwrap();
        let walls = w.wall_jvp().unwrap().to_vec();
        let eps = 1e-4;
        let shifted = |sign: f64| {
            waters.map(|q| Water {
                temperature_k: q.temperature_k + sign * eps * dw.temperature_k,
                mass_flow_kg_s: q.mass_flow_kg_s + sign * eps * dw.mass_flow_kg_s,
                conductivity_w_m_k: q.conductivity_w_m_k + sign * eps * dw.conductivity_w_m_k,
                viscosity_pa_s: q.viscosity_pa_s + sign * eps * dw.viscosity_pa_s,
                cp_j_kg_k: q.cp_j_kg_k + sign * eps * dw.cp_j_kg_k,
                ..q
            })
        };
        let mut wp = m.workspace();
        let mut wm = m.workspace();
        m.evaluate_into(&t, &dep, &shifted(1.), &mut wp).unwrap();
        m.evaluate_into(&t, &dep, &shifted(-1.), &mut wm).unwrap();
        for i in 0..2 {
            close(
                walls[i],
                (wp.wall_rates().unwrap()[i] - wm.wall_rates().unwrap()[i]) / (2. * eps),
                2e-7,
                1e-5,
            );
        }
        close(
            w.heat_jvp().unwrap().iter().sum::<f64>() + w.wall_jvp().unwrap().iter().sum::<f64>(),
            0.,
            0.,
            1e-8,
        );
    }
    #[test]
    fn positive_contacts_dissipate_and_equal_half_gaps_recover_series_resistance() {
        let m = model();
        let b = &m.bands[0];
        let tf = 310.;
        let tc = 300.;
        let tg = (tf + tc) / 2.;
        let (g, _) = m.gap(b, tg);
        let qf = g * (tf - tg);
        let qc = g * (tg - tc);
        assert_eq!(qf, qc);
        close(qf, (g / 2.) * (tf - tc), 0., 0.);
        assert!(qf * (1. / tg - 1. / tf) + qc * (1. / tc - 1. / tg) > 0.);
        for flow in [-5000., 0., 5000.] {
            for t in [290., 300., 310.] {
                let q = wall(
                    &b.input,
                    t,
                    water(300., flow),
                    0.,
                    WaterDirection::default(),
                )
                .0;
                assert!(q * (1. / 300. - 1. / t) >= 0.);
            }
        }
    }
    #[test]
    fn wall_switch_uses_declared_fixed_heating_linearization_not_two_sided_fd() {
        let m = model();
        let b = &m.bands[0].input;
        let w = water(300., 5000.);
        let (_, heating) = wall(b, 300., w, 1., WaterDirection::default());
        let (_, opposite) = wall(b, 300., w, -1., WaterDirection::default());
        assert_eq!(heating, -opposite); // The callback is a linear operator.
        let step = 1e-4;
        let plus = wall(b, 300. + step, w, 0., WaterDirection::default()).0 / step;
        let minus = wall(b, 300. - step, w, 0., WaterDirection::default()).0 / -step;
        close(heating, plus, 1e-9, 1e-8);
        assert!((heating - minus).abs() > 0.01 * heating.abs());
        // At zero flow both exponents select the same conduction floor.
        let w0 = water(300., 0.);
        let (_, d0) = wall(b, 300., w0, 1., WaterDirection::default());
        close(
            d0,
            wall(b, 300. - step, w0, 0., WaterDirection::default()).0 / -step,
            1e-9,
            1e-8,
        );
    }
    #[test]
    fn local_sparse_heat_derivatives_match_independent_jvp_with_shared_helium() {
        let m = model();
        let n = m.node_count();
        assert_eq!(m.water_count(), 2);
        assert_eq!(m.band_water(0), 0);
        assert_eq!(m.fuel_node_count(), 6);
        assert!(m.is_fuel_node(m.fuel_rows(1).start));
        assert!(!m.is_fuel_node(m.clad_rows(1).start));
        assert!(!m.is_fuel_node(m.helium_row(0)));
        let mut w = m.workspace();
        let mut t = (0..n).map(|i| 510. + i as f64).collect::<Vec<_>>();
        t[m.helium_row(0)] = 520.;
        let dep = vec![0.; n];
        let water = [water(490., 5000.), water(480., -5000.)];
        assert!(m.visit_heat_derivatives(&w, |_, _, _| {}).is_err());
        m.evaluate_into(&t, &dep, &water, &mut w).unwrap();
        let mut matrix = vec![0.; n * n];
        m.visit_heat_derivatives(&w, |r, c, v| matrix[r * n + c] += v)
            .unwrap();
        // Every column is a test oracle only; production assembly emits local
        // contacts directly and does not perform whole-operator basis probes.
        for c in 0..n {
            let mut d = vec![0.; n];
            d[c] = 1.;
            m.jvp_into(&d, &dep, &[WaterDirection::default(); 2], &mut w)
                .unwrap();
            for r in 0..n {
                close(matrix[r * n + c], w.heat_jvp().unwrap()[r], 2e-14, 1e-10);
            }
        }
        // Shared gas couples both bands; there is no instantaneous direct
        // fuel-to-fuel cross term that would recreate a massless gas alias.
        let h = m.helium_row(0);
        assert!(matrix[m.fuel_rows(0).end * n - n + h] > 0.);
        assert!(matrix[(m.fuel_rows(1).end - 1) * n + h] > 0.);
        assert_eq!(
            matrix[(m.fuel_rows(0).end - 1) * n + m.fuel_rows(1).end - 1],
            0.
        );
        assert!(model().visit_heat_derivatives(&w, |_, _, _| {}).is_err());
        t[0] = 289.;
        assert!(m.evaluate_into(&t, &dep, &water, &mut w).is_err());
        assert!(m.visit_heat_derivatives(&w, |_, _, _| {}).is_err());
    }
    #[test]
    fn failed_foreign_and_changed_trials_cannot_reuse_stale_heat_or_derivatives() {
        let m = model();
        let other = model();
        let n = m.node_count();
        let mut w = m.workspace();
        let mut t = vec![300.; n];
        let dep = vec![0.; n];
        let waters = [water(300., 0.); 2];
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        t[m.helium_row(0)] = 301.;
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        assert!(w.heat_rates().unwrap()[m.fuel_rows(0).end - 1] > 0.);
        t[0] = 289.;
        assert!(m.evaluate_into(&t, &dep, &waters, &mut w).is_err());
        assert!(w.heat_rates().is_err());
        assert!(
            m.jvp_into(&vec![0.; n], &dep, &[WaterDirection::default(); 2], &mut w)
                .is_err()
        );
        t[0] = 300.;
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        assert!(other.evaluate_into(&t, &dep, &waters, &mut w).is_err());
        assert!(w.energies().is_err());
        let mut b = band(0, 0, 3, 3);
        b.clad_inner_radius_m = b.fuel_radius_m;
        assert!(Model::new(vec![b], vec![helium()], 1).is_err());
        assert!(Model::new(vec![band(0, 0, 3, 3)], vec![helium(), helium()], 1).is_err());
    }
    #[test]
    fn sensible_wall_branch_refuses_actual_saturation_boundary_without_clamping() {
        let m = model();
        let mut w = m.workspace();
        let mut t = vec![300.; m.node_count()];
        let dep = vec![0.; m.node_count()];
        let mut waters = [water(300., 0.); 2];
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        t[m.clad_rows(0).end - 1] = waters[0].saturation_temperature_k;
        assert!(m.evaluate_into(&t, &dep, &waters, &mut w).is_err());
        assert!(w.heat_rates().is_err());
        assert_eq!(
            t[m.clad_rows(0).end - 1],
            waters[0].saturation_temperature_k
        );
        t[m.clad_rows(0).end - 1] = 300.;
        waters[0].temperature_k = waters[0].saturation_temperature_k;
        assert!(m.evaluate_into(&t, &dep, &waters, &mut w).is_err());
        waters[0].temperature_k = 300.;
        waters[0].saturation_temperature_k = f64::NAN;
        assert!(m.evaluate_into(&t, &dep, &waters, &mut w).is_err());
        waters[0] = water(300., 0.);
        m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
        assert_eq!(w.wall_rates().unwrap()[0], 0.);
    }
    #[test]
    fn full_selected_count_component_evaluation_not_an_advancing_plant() {
        let bands = (0..193)
            .flat_map(|h| (0..4).map(move |b| band(h, b / 2, 9, 3)))
            .collect();
        let m = Model::new(bands, vec![helium(); 193], 2).unwrap();
        assert_eq!(m.node_count(), 9264 + 193);
        assert_eq!(m.band_count(), 772);
        let mut w = m.workspace();
        let t = vec![300.; m.node_count()];
        let dep = vec![0.; m.node_count()];
        let waters = [water(305., 0.); 2];
        let start = std::time::Instant::now();
        for _ in 0..3 {
            m.evaluate_into(&t, &dep, &waters, &mut w).unwrap();
            m.jvp_into(
                &vec![0.; m.node_count()],
                &dep,
                &[WaterDirection::default(); 2],
                &mut w,
            )
            .unwrap();
        }
        eprintln!(
            "Test apparatus 9264 solid+193 helium, three RHS+JVP calls {:?}; no simulated time",
            start.elapsed()
        );
        close(
            w.heat_rates().unwrap().iter().sum::<f64>()
                + w.wall_rates().unwrap().iter().sum::<f64>(),
            0.,
            0.,
            1e-6,
        );
        assert_eq!(w.energy_jvp().unwrap().iter().sum::<f64>(), 0.);
    }
}

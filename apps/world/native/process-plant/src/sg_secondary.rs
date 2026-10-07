//! Closed, noncondensable-aware equilibrium SG secondary, cold/full-wet only.
//! Species masses are immutable finite owned inventories. U is history; p/T
//! are forward chart coordinates. No dryout, boiling, ports or fixed heat bath.
//! Narrow native property domain: 273.15..623.15 K and IF97 Pmin..20 MPa,
//! with bulk/wall below total-pressure saturation and positive retained air.
use crate::{GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::ffi::{CStr, c_char};
pub const RA: f64 = 287.;
pub const RN: f64 = 296.8;
pub const CVA: f64 = 718.;
pub const CVN: f64 = 742.;
pub const GAS_DATUM: f64 = 298.15;
#[derive(Clone, Copy, Debug)]
pub struct Secondary {
    pub volume: f64,
    pub initial_temperature: f64,
    pub initial_pressure: f64,
    pub initial_liquid_volume: f64,
    pub initial_nitrogen_mass: f64,
    pub minimum_wetted_liquid_volume: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct SecondaryHeat {
    pub solid: usize,
    pub secondary: usize,
    pub area: f64,
    pub diameter: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Inventory {
    pub water: f64,
    pub air: f64,
    pub nitrogen: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct State {
    pub energy: f64,
    pub pressure_residual: f64,
    pub liquid_mass: f64,
    pub vapor_mass: f64,
    pub liquid_volume: f64,
    pub gas_volume: f64,
    pub saturation_pressure: f64,
    pub saturation_temperature: f64,
    pub liquid: Liquid,
}
unsafe extern "C" {
    fn leitbild_cold_wet(
        t: f64,
        p: f64,
        l: *mut Liquid,
        v: *mut Liquid,
        s: *mut f64,
        error: *mut c_char,
        cap: usize,
    ) -> i32;
}
pub(crate) fn endpoints(t: f64, p: f64) -> Result<(Liquid, Liquid, [f64; 2]), String> {
    let mut l = Liquid::default();
    let mut v = Liquid::default();
    let mut sat = [0.; 2];
    let mut error = [0 as c_char; 256];
    // POD outputs are owned here; the exception-contained bridge retains nothing.
    let status = unsafe {
        leitbild_cold_wet(
            t,
            p,
            &mut l,
            &mut v,
            sat.as_mut_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(unsafe { CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned());
    }
    if ![
        l.density,
        l.internal_energy,
        v.density,
        v.internal_energy,
        sat[0],
        sat[1],
    ]
    .iter()
    .all(|x| x.is_finite())
        || l.density <= v.density
        || v.density <= 0.
    {
        return Err("Invalid wet endpoint tuple".into());
    }
    Ok((l, v, sat))
}
/// Same-pressure IF97 saturation boundary for a fully wet sensible contact.
/// A physical domain check, not an imposed wall temperature or heat source.
pub fn cold_saturation_temperature(t: f64, p: f64) -> Result<f64, String> {
    Ok(endpoints(t,p)?.2[1])
}
impl Secondary {
    /// Bounded local forward chart probes: [U_T,U_p,G_T,G_p]. No chart solve.
    pub fn derivatives(self, i: Inventory, t: f64, p: f64) -> Result<[f64; 4], String> {
        let dt = 1e-3;
        let dp = (p * 1e-5).max(0.1);
        let a = self.evaluate(i, t + dt, p)?;
        let b = self.evaluate(i, t - dt, p)?;
        let c = self.evaluate(i, t, p + dp)?;
        let d = self.evaluate(i, t, p - dp)?;
        let out = [
            (a.energy - b.energy) / (2. * dt),
            (c.energy - d.energy) / (2. * dp),
            (a.pressure_residual - b.pressure_residual) / (2. * dt),
            (c.pressure_residual - d.pressure_residual) / (2. * dp),
        ];
        if !out.iter().all(|x| x.is_finite())
            || out[3] <= 0.
            || out[0] - out[1] * out[2] / out[3] <= 0.
        {
            return Err("Singular wet secondary energy/pressure chart".into());
        }
        Ok(out)
    }
    pub fn prepare(self) -> Result<(Inventory, State), String> {
        if ![
            self.volume,
            self.initial_temperature,
            self.initial_pressure,
            self.initial_liquid_volume,
            self.initial_nitrogen_mass,
            self.minimum_wetted_liquid_volume,
        ]
        .iter()
        .all(|x| x.is_finite())
            || self.volume <= 0.
            || self.initial_liquid_volume <= 0.
            || self.initial_liquid_volume >= self.volume
            || self.initial_nitrogen_mass < 0.
            || self.minimum_wetted_liquid_volume <= 0.
            || self.initial_liquid_volume < self.minimum_wetted_liquid_volume
        {
            return Err("Invalid original wet secondary".into());
        }
        let (l, v, s) = endpoints(self.initial_temperature, self.initial_pressure)?;
        let vg = self.volume - self.initial_liquid_volume;
        let air = ((self.initial_pressure - s[0]) * vg / self.initial_temperature
            - self.initial_nitrogen_mass * RN)
            / RA;
        if !air.is_finite() || air <= 0. {
            return Err("Cold wet secondary requires positive air inventory".into());
        }
        let i = Inventory {
            water: l.density * self.initial_liquid_volume + v.density * vg,
            air,
            nitrogen: self.initial_nitrogen_mass,
        };
        Ok((
            i,
            self.evaluate(i, self.initial_temperature, self.initial_pressure)?,
        ))
    }
    pub fn evaluate(self, i: Inventory, t: f64, p: f64) -> Result<State, String> {
        if ![self.volume, self.minimum_wetted_liquid_volume]
            .iter()
            .all(|x| x.is_finite())
            || self.volume <= 0.
            || self.minimum_wetted_liquid_volume <= 0.
            || self.minimum_wetted_liquid_volume >= self.volume
        {
            return Err("Invalid wet secondary volume/contact geometry".into());
        }
        if ![i.water, i.air, i.nitrogen, t, p]
            .iter()
            .all(|x| x.is_finite())
            || i.water <= 0.
            || i.air <= 0.
            || i.nitrogen < 0.
        {
            return Err("Invalid closed wet inventory/trial".into());
        }
        let (l, v, s) = endpoints(t, p)?;
        let ml = (i.water - v.density * self.volume) / (1. - v.density / l.density);
        let vl = ml / l.density;
        let vg = self.volume - vl;
        let mv = v.density * vg;
        if ![ml, vl, vg, mv].iter().all(|x| x.is_finite())
            || ml <= 0.
            || mv <= 0.
            || vg <= 0.
            || vl < self.minimum_wetted_liquid_volume
        {
            return Err("Secondary left positive, fully wetted cold branch".into());
        }
        let energy = ml * l.internal_energy
            + mv * v.internal_energy
            + (i.air * CVA + i.nitrogen * CVN) * (t - GAS_DATUM);
        let pressure_residual = p - s[0] - (i.air * RA + i.nitrogen * RN) * t / vg;
        if !energy.is_finite() || !pressure_residual.is_finite() {
            return Err("Nonfinite wet chart".into());
        }
        Ok(State {
            energy,
            pressure_residual,
            liquid_mass: ml,
            vapor_mass: mv,
            liquid_volume: vl,
            gas_volume: vg,
            saturation_pressure: s[0],
            saturation_temperature: s[1],
            liquid: l,
        })
    }
}
fn film(l: Liquid, area: f64, d: f64) -> Result<[f64; 2], String> {
    let pr = l.cp * l.viscosity / l.conductivity;
    let r = GRAVITY * l.expansion * d.powi(3)
        / (l.viscosity / l.density * l.conductivity / (l.density * l.cp));
    let c = 0.387 * r.powf(1. / 6.) / (1. + (0.559 / pr).powf(9. / 16.)).powf(8. / 27.);
    let a = area * l.conductivity / d;
    if ![a, c, pr, r].iter().all(|x| x.is_finite()) || a <= 0. || c < 0. || pr <= 0. {
        return Err("Invalid external cold wet film".into());
    }
    Ok([a, c])
}
/// Whole signed flux: its derivative is finite at zero contrast despite the
/// singular derivative of h alone. Film coefficients depend on actual state.
pub fn heat(
    t: f64,
    p: f64,
    wall: f64,
    area: f64,
    d: f64,
    requests: &mut usize,
) -> Result<f64, String> {
    Ok(heat_with_partials(t, p, wall, area, d, false, requests)?.0)
}
/// Analytic contrast derivative, with bounded local forward probes ONLY for
/// the two film coefficients' p/Tfilm dependence. No finite secant through the
/// |wall-bulk| cusp, no positive contrast floor and no fixed film coefficient.
pub fn heat_with_partials(
    t: f64,
    p: f64,
    wall: f64,
    area: f64,
    d: f64,
    tangent: bool,
    requests: &mut usize,
) -> Result<(f64, [f64; 3]), String> {
    let (_, _, s) = endpoints(t, p)?;
    *requests += 2;
    if ![wall, area, d].iter().all(|x| x.is_finite())
        || wall <= 0.
        || area <= 0.
        || d <= 0.
        || wall > s[1]
    {
        return Err("Secondary contact left subboiling branch".into());
    }
    let tf = (t + wall) * 0.5;
    let mut out = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            temperature: tf,
            pressure: p,
        }],
        &mut out,
    )
    .map_err(|e| e.message)?;
    *requests += 1;
    let delta = wall - t;
    let [a, c] = film(out[0], area, d)?;
    let x = delta.abs().powf(1. / 6.);
    let b = c * x;
    let z = 0.6 + b;
    let q = a * z * z * delta;
    let mut partials = [0.; 3];
    if tangent {
        let contrast = a * (z * z + z * b / 3.);
        let dt = 1e-3;
        let dp = (p * 1e-5).max(0.1);
        let queries = [
            LiquidQuery {
                temperature: tf + dt,
                pressure: p,
            },
            LiquidQuery {
                temperature: tf - dt,
                pressure: p,
            },
            LiquidQuery {
                temperature: tf,
                pressure: p + dp,
            },
            LiquidQuery {
                temperature: tf,
                pressure: p - dp,
            },
        ];
        let mut props = [Liquid::default(); 4];
        liquid_batch(&queries, &mut props).map_err(|e| e.message)?;
        *requests += 4;
        let mut coeff = [[0.; 2]; 4];
        for j in 0..4 {
            coeff[j] = film(props[j], area, d)?;
        }
        let dft = delta
            * ((coeff[0][0] - coeff[1][0]) / (2. * dt) * z * z
                + 2. * a * z * x * (coeff[0][1] - coeff[1][1]) / (2. * dt));
        let dfp = delta
            * ((coeff[2][0] - coeff[3][0]) / (2. * dp) * z * z
                + 2. * a * z * x * (coeff[2][1] - coeff[3][1]) / (2. * dp));
        partials = [-contrast + 0.5 * dft, dfp, contrast + 0.5 * dft];
    }
    if !q.is_finite() || !partials.iter().all(|x| x.is_finite()) {
        return Err("Nonfinite external cold wet flux/tangent".into());
    }
    Ok((q, partials))
}

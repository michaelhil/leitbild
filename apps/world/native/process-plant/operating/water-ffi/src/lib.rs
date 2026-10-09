//! The only unsafe water boundary. The pure operating equation crate remains
//! unsafe-forbidden and has no dependency on this opt-in native package.

use std::fmt;

#[derive(Clone, Copy, Debug)]
#[repr(i32)]
pub enum Branch {
    Liquid = 0,
    Vapor = 1,
    SaturatedLiquid = 2,
    SaturatedVapor = 3,
}

/// C layout checked by actual calls, not a serialized approximation to IF97.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct WaterPoint {
    pub region: i32,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub cp_j_kg_k: f64,
    pub cv_j_kg_k: f64,
    pub expansion_per_k: f64,
    pub compressibility_per_pa: f64,
    pub viscosity_pa_s: f64,
    pub conductivity_w_m_k: f64,
    pub saturation_slope_k_pa: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    Domain,
    AbiArgument,
    NativeFailure,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating IF97: {self:?}")
    }
}
impl std::error::Error for Error {}

unsafe extern "C" {
    fn ld01_water_point(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_direction(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        pressure_direction: f64,
        temperature_direction: f64,
        output: *mut WaterPoint,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_surface(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
    fn ld01_water_vapor_sat_density(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
}

pub fn point(branch: Branch, pressure_pa: f64, temperature_k: f64) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: repr(C) contains only C int/doubles in declared order. Pointer
    // refers to a unique live stack allocation; C writes its complete tuple on
    // success, keeps no pointer, and catches every C++ exception. The enum has
    // only the four supported ABI discriminants. No buffer or allocator crosses.
    let status =
        unsafe { ld01_water_point(branch as i32, pressure_pa, temperature_k, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Exact rho/u/h directional response; disclosed same-branch second-order
/// coefficient probes for transport/cp/alpha. No whole-model probing or cache.
pub fn directional(
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    let mut value = WaterPoint::default();
    let mut direction = WaterPoint::default();
    // SAFETY: same C-layout contract as point; outputs are distinct live unique
    // stack allocations, retained nowhere. The native function catches errors.
    let status =
        unsafe { ld01_water_direction(branch as i32, p, t, dp, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

pub fn surface_tension(t: f64, dt: f64) -> Result<(f64, f64), Error> {
    let mut value = 0.;
    let mut direction = 0.;
    // SAFETY: two unique live scalar outputs; C keeps no pointers/catches errors.
    let status = unsafe { ld01_water_surface(t, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Actual property adapter consumed by the native thermal residual/JVP.
pub struct If97;
fn thermal_point(q: WaterPoint, d: WaterPoint) -> leitbild_operating_plant::thermal::WaterPoint {
    use leitbild_operating_plant::thermal::{Scalar, WaterPoint as ThermalPoint};
    ThermalPoint {
        density: Scalar::new(q.density_kg_m3, d.density_kg_m3),
        viscosity: Scalar::new(q.viscosity_pa_s, d.viscosity_pa_s),
        conductivity: Scalar::new(q.conductivity_w_m_k, d.conductivity_w_m_k),
        cp: Scalar::new(q.cp_j_kg_k, d.cp_j_kg_k),
        expansion: Scalar::new(q.expansion_per_k, d.expansion_per_k),
        enthalpy: Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    }
}
impl leitbild_operating_plant::thermal::WaterProperties for If97 {
    fn liquid(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
    {
        let (q, d) = directional(Branch::Liquid, p.value, t.value, p.direction, t.direction)
            .map_err(|_| "maintained IF97 liquid domain/derivative")?;
        Ok(thermal_point(q, d))
    }
    fn vapor(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
    {
        let (q, d) = directional(Branch::Vapor, p.value, t.value, p.direction, t.direction)
            .map_err(|_| "maintained IF97 vapor domain/derivative")?;
        Ok(thermal_point(q, d))
    }
    fn saturation(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Saturation>
    {
        use leitbild_operating_plant::thermal::{Saturation, Scalar};
        let (l, dl) = directional(Branch::SaturatedLiquid, p.value, 0., p.direction, 0.)
            .map_err(|_| "maintained IF97 saturation liquid")?;
        let (g, dg) = directional(Branch::SaturatedVapor, p.value, 0., p.direction, 0.)
            .map_err(|_| "maintained IF97 saturation vapor")?;
        let (sigma, dsigma) = surface_tension(l.temperature_k, dl.temperature_k)
            .map_err(|_| "maintained IF97 surface tension")?;
        Ok(Saturation {
            temperature: Scalar::new(l.temperature_k, dl.temperature_k),
            liquid: thermal_point(l, dl),
            vapor: thermal_point(g, dg),
            surface_tension: Scalar::new(sigma, dsigma),
        })
    }
    fn saturated_vapor_density(
        &self,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Scalar> {
        let mut value = 0.;
        let mut direction = 0.;
        // SAFETY: unique scalar outputs, no retained pointer; checked native
        // saturation call catches exceptions, using its actual inverse slope.
        let status = unsafe {
            ld01_water_vapor_sat_density(t.value, t.direction, &mut value, &mut direction)
        };
        if status != 0 {
            return Err("maintained IF97 wall saturation density");
        }
        Ok(leitbild_operating_plant::thermal::Scalar::new(
            value, direction,
        ))
    }
}

impl WaterPoint {
    /// Exact thermodynamic first partials at this branch; viscosity/conductivity
    /// derivatives are not invented here. The thermal join must supply those
    /// additional local coefficient derivatives when assembling its Jacobian.
    pub fn phase_point(self) -> leitbild_operating_plant::phase::Point {
        let p = self.pressure_pa;
        let t = self.temperature_k;
        let r = self.density_kg_m3;
        let a = self.expansion_per_k;
        let k = self.compressibility_per_pa;
        leitbild_operating_plant::phase::Point {
            pressure_pa: p,
            temperature_k: t,
            density_kg_m3: r,
            internal_energy_j_kg: self.internal_energy_j_kg,
            enthalpy_j_kg: self.enthalpy_j_kg,
            density_pressure: r * k,
            density_temperature: -r * a,
            energy_pressure: (p * k - t * a) / r,
            energy_temperature: self.cp_j_kg_k - p * a / r,
        }
    }
}

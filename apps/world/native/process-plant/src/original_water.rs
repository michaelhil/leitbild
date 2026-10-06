//! ORIGINAL stable-liquid preparation only. Never project or reset a reached stock.
//! The selected main field has constant entropy and h(z)+g*z constant;
//! LOWER's external mixed owner deliberately uses its separate mean-head law.
use crate::{GRAVITY, Liquid, LiquidQuery, liquid_batch};

fn water(pressure: f64, temperature: f64) -> Result<Liquid, String> {
    let mut out = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure,
            temperature,
        }],
        &mut out,
    )
    .map_err(|e| e.message)?;
    Ok(out[0])
}

#[derive(Clone, Copy)]
pub struct OriginalField {
    datum: Liquid,
    datum_elevation: f64,
    minimum_span: f64,
    relative_mass_screen: f64,
}

impl OriginalField {
    pub fn new(
        pressure: f64,
        temperature: f64,
        elevation: f64,
        minimum_span: f64,
        relative_mass_screen: f64,
    ) -> Result<Self, String> {
        if !elevation.is_finite()
            || !minimum_span.is_finite()
            || minimum_span <= 0.0
            || !relative_mass_screen.is_finite()
            || relative_mass_screen <= 0.0
            || relative_mass_screen >= 1.0
        {
            return Err("Nonfinite original datum".into());
        }
        Ok(Self {
            datum: water(pressure, temperature)?,
            datum_elevation: elevation,
            minimum_span,
            relative_mass_screen,
        })
    }

    /// Exact selected H/S equations, local analytic Newton—not a hydrostatic ODE.
    pub fn at(&self, elevation: f64) -> Result<Liquid, String> {
        if !elevation.is_finite() {
            return Err("Nonfinite original point".into());
        }
        let h = self.datum.enthalpy + GRAVITY * (self.datum_elevation - elevation);
        let s = self.datum.entropy;
        let mut q = self.datum;
        let mut diagnostic = [[0.0; 4]; 12];
        for row in &mut diagnostic {
            let dh = h - q.enthalpy;
            let ds = s - q.entropy;
            *row = [q.pressure, q.temperature, dh, ds];
            // Inverse of dh=v(1−Tα)dp+cp*dT; ds=−vα*dp+cp/T*dT.
            let dp = q.density * (dh - q.temperature * ds);
            let dt = q.expansion * q.temperature / q.cp * dh
                + q.temperature * (1.0 - q.expansion * q.temperature) / q.cp * ds;
            // ORIGINAL-only allocation from the actual smallest meaningful slab
            // and the independent mass discriminator. Last-bit h/s cycles must
            // not overrule accurate joint correction coordinates. These tests
            // alone do NOT admit the prepared stocks: external H/S and M=AΔp/g
            // checks remain decisive in the caller's unchanged finite contract.
            let allocation = self.relative_mass_screen / 4.0;
            if dp.is_finite()
                && dt.is_finite()
                && dp.abs() <= allocation * q.density * GRAVITY * self.minimum_span
                && (q.expansion * dt).abs() <= allocation
            {
                return Ok(q);
            }
            q = water(q.pressure + dp, q.temperature + dt)?;
        }
        Err(format!(
            "Original H/S preparation did not meet its finite residual screen: z={elevation:.17e}, target_h={h:.17e}, target_s={s:.17e}, final_p={:.17e}, final_T={:.17e}, final_dh={:.17e}, final_ds={:.17e}, actual_iterations_p_T_dh_ds={diagnostic:?}",
            q.pressure,
            q.temperature,
            h - q.enthalpy,
            s - q.entropy
        ))
    }

    /// The existing LOWER external owner is not silently changed into an H/S layer.
    pub fn mixed_lower(&self) -> Result<Liquid, String> {
        let entry = self.at(-2.0)?;
        let mut q = water(entry.pressure + entry.density * GRAVITY, entry.temperature)?;
        for _ in 0..12 {
            let f = q.pressure - q.density * GRAVITY - entry.pressure;
            if f.abs() <= 2e-7 {
                return Ok(q);
            }
            let d = 1.0 - GRAVITY * q.density * q.compressibility;
            if !d.is_finite() || d <= 0.0 {
                return Err("Mixed LOWER pressure recovery lost rank".into());
            }
            q = water(q.pressure - f / d, entry.temperature)?;
        }
        Err("Mixed LOWER preparation did not meet its finite residual screen".into())
    }
}

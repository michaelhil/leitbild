//! Local pure-water pressure/phase constraints and reciprocal interphase work.
//!
//! Separated liquid/gas energy remains separated (the selected PZR carrier).
//! An SG's explicitly selected saturated equilibrium chart is a different
//! function, not a fallback for the PZR. Maintained property values/partials are
//! supplied at the SAME trial point. No EOS fit, inverse, integrator, seed phase,
//! common-temperature reset, or accepted-state clipping lives here.

use std::fmt;

#[derive(Clone, Copy, Debug, Default)]
pub struct Point {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub density_pressure: f64,
    pub density_temperature: f64,
    pub energy_pressure: f64,
    pub energy_temperature: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stock {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    InvalidInput(&'static str),
    InvalidAcceptedState(&'static str),
    SingularChart,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating phase: {self:?}")
    }
}
impl std::error::Error for Error {}

fn finite(values: &[f64]) -> Result<(), Error> {
    if values.iter().any(|v| !v.is_finite()) {
        Err(Error::InvalidInput("nonfinite"))
    } else {
        Ok(())
    }
}
fn point(p: Point) -> Result<(), Error> {
    finite(&[
        p.pressure_pa,
        p.temperature_k,
        p.density_kg_m3,
        p.internal_energy_j_kg,
        p.enthalpy_j_kg,
        p.density_pressure,
        p.density_temperature,
        p.energy_pressure,
        p.energy_temperature,
    ])?;
    if p.pressure_pa <= 0. || p.temperature_k <= 0. || p.density_kg_m3 <= 0. {
        return Err(Error::InvalidInput("positive physical property point"));
    }
    Ok(())
}
fn volume(v: f64) -> Result<(), Error> {
    if !v.is_finite() || v <= 0. {
        Err(Error::InvalidInput("volume"))
    } else {
        Ok(())
    }
}

/// Four local algebraic rows for [p,Tl,Tg,Vl]. Stocks are independently retained
/// Ml,Ul,Mg,Ug. Both phase properties must use the same mechanical pressure.
#[derive(Clone, Copy, Debug)]
pub struct Separated {
    pub residual: [f64; 4],
    /// Columns p,Tl,Tg,Vl; no frozen-property approximation.
    pub algebraic_jacobian: [[f64; 4]; 4],
    /// Columns Ml,Ul,Mg,Ug.
    pub stock_jacobian: [[f64; 4]; 4],
}

pub fn separated_constraints(
    v: f64,
    vl: f64,
    l: Stock,
    g: Stock,
    lp: Point,
    gp: Point,
) -> Result<Separated, Error> {
    volume(v)?;
    point(lp)?;
    point(gp)?;
    finite(&[
        vl,
        l.mass_kg,
        l.internal_energy_j,
        g.mass_kg,
        g.internal_energy_j,
    ])?;
    if lp.pressure_pa != gp.pressure_pa {
        return Err(Error::InvalidInput("different phase pressures"));
    }
    let rl = lp.density_kg_m3;
    let rg = gp.density_kg_m3;
    let rows = Separated {
        residual: [
            l.internal_energy_j - l.mass_kg * lp.internal_energy_j_kg,
            g.internal_energy_j - g.mass_kg * gp.internal_energy_j_kg,
            vl - l.mass_kg / rl,
            v - vl - g.mass_kg / rg,
        ],
        algebraic_jacobian: [
            [
                -l.mass_kg * lp.energy_pressure,
                -l.mass_kg * lp.energy_temperature,
                0.,
                0.,
            ],
            [
                -g.mass_kg * gp.energy_pressure,
                0.,
                -g.mass_kg * gp.energy_temperature,
                0.,
            ],
            [
                l.mass_kg * lp.density_pressure / (rl * rl),
                l.mass_kg * lp.density_temperature / (rl * rl),
                0.,
                1.,
            ],
            [
                g.mass_kg * gp.density_pressure / (rg * rg),
                0.,
                g.mass_kg * gp.density_temperature / (rg * rg),
                -1.,
            ],
        ],
        stock_jacobian: [
            [-lp.internal_energy_j_kg, 1., 0., 0.],
            [0., 0., -gp.internal_energy_j_kg, 1.],
            [-1. / rl, 0., 0., 0.],
            [0., 0., -1. / rg, 0.],
        ],
    };
    finite(&rows.residual)?;
    for row in rows
        .algebraic_jacobian
        .iter()
        .chain(rows.stock_jacobian.iter())
    {
        finite(row)?;
    }
    Ok(rows)
}

/// Pure branch has two constraints and NO absent-phase temperature/energy.
/// Density/energy map uses only its actual retained mass and internal energy.
pub fn single_constraints(v: f64, s: Stock, p: Point) -> Result<([f64; 2], [[f64; 2]; 2]), Error> {
    volume(v)?;
    point(p)?;
    finite(&[s.mass_kg, s.internal_energy_j])?;
    let r = p.density_kg_m3;
    let residual = [
        s.internal_energy_j - s.mass_kg * p.internal_energy_j_kg,
        v - s.mass_kg / r,
    ];
    let jacobian = [
        [
            -s.mass_kg * p.energy_pressure,
            -s.mass_kg * p.energy_temperature,
        ],
        [
            s.mass_kg * p.density_pressure / (r * r),
            s.mass_kg * p.density_temperature / (r * r),
        ],
    ];
    finite(&residual)?;
    for row in &jacobian {
        finite(row)?;
    }
    Ok((residual, jacobian))
}

pub fn validate_separated_accepted(v: f64, vl: f64, l: Stock, g: Stock) -> Result<(), Error> {
    volume(v)?;
    finite(&[
        vl,
        l.mass_kg,
        l.internal_energy_j,
        g.mass_kg,
        g.internal_energy_j,
    ])?;
    if vl <= 0. || vl >= v || l.mass_kg <= 0. || g.mass_kg <= 0. {
        return Err(Error::InvalidAcceptedState(
            "two present finite phases required",
        ));
    }
    // Internal energy has the maintained EOS datum, not a generic positivity
    // rule. Property/coherence admission is performed on the actual chart.
    Ok(())
}

pub fn validate_single_accepted(present: Stock, absent: Stock) -> Result<(), Error> {
    finite(&[
        present.mass_kg,
        present.internal_energy_j,
        absent.mass_kg,
        absent.internal_energy_j,
    ])?;
    if present.mass_kg <= 0. || absent.mass_kg != 0. || absent.internal_energy_j != 0. {
        return Err(Error::InvalidAcceptedState("absent phase has no stock"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Exchange {
    pub liquid_mass_kg_s: f64,
    pub vapor_mass_kg_s: f64,
    pub liquid_energy_w: f64,
    pub vapor_energy_w: f64,
}

/// Actual two-sided Stefan receipt at a same-pressure interface. ql/qg are
/// signed heat FROM their bulk phase TO the interface. hli/hgi are maintained
/// saturation endpoint enthalpies at this pressure. No latent heat is paid a
/// second time. Phase-volume work belongs in addition to this source vector.
pub fn interphase(ql: f64, qg: f64, hli: f64, hgi: f64) -> Result<Exchange, Error> {
    finite(&[ql, qg, hli, hgi])?;
    let latent = hgi - hli;
    if latent <= 0. {
        return Err(Error::InvalidInput("positive latent enthalpy"));
    }
    let gamma = (ql + qg) / latent;
    let out = Exchange {
        liquid_mass_kg_s: -gamma,
        vapor_mass_kg_s: gamma,
        liquid_energy_w: -gamma * hli - ql,
        vapor_energy_w: gamma * hgi - qg,
    };
    finite(&[
        out.liquid_mass_kg_s,
        out.vapor_mass_kg_s,
        out.liquid_energy_w,
        out.vapor_energy_w,
    ])?;
    Ok(out)
}

pub fn interphase_direction(
    ql: f64,
    qg: f64,
    hli: f64,
    hgi: f64,
    direction: [f64; 4],
) -> Result<Exchange, Error> {
    let value = interphase(ql, qg, hli, hgi)?;
    finite(&direction)?;
    let [dql, dqg, dhli, dhgi] = direction;
    let gamma = value.vapor_mass_kg_s;
    let dgamma = (dql + dqg - gamma * (dhgi - dhli)) / (hgi - hli);
    let out = Exchange {
        liquid_mass_kg_s: -dgamma,
        vapor_mass_kg_s: dgamma,
        liquid_energy_w: -dgamma * hli - gamma * dhli - dql,
        vapor_energy_w: dgamma * hgi + gamma * dhgi - dqg,
    };
    finite(&[
        out.liquid_mass_kg_s,
        out.vapor_mass_kg_s,
        out.liquid_energy_w,
        out.vapor_energy_w,
    ])?;
    Ok(out)
}

/// Local internal-energy pressure work for a FIXED total-volume cell.
/// Equal/opposite phase work cancels, but each local energy equation needs it.
pub fn phase_volume_work(
    pressure_pa: f64,
    liquid_volume_rate_m3_s: f64,
) -> Result<[f64; 2], Error> {
    finite(&[pressure_pa, liquid_volume_rate_m3_s])?;
    if pressure_pa <= 0. {
        return Err(Error::InvalidInput("pressure work pressure"));
    }
    let work = pressure_pa * liquid_volume_rate_m3_s;
    finite(&[work])?;
    Ok([-work, work])
}

#[derive(Clone, Copy, Debug)]
pub struct Equilibrium {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    /// Derivatives [dM/dp,dM/dVl,dU/dp,dU/dVl] along saturation.
    pub derivative: [f64; 4],
}

/// Selected SG pure-water saturated chart, INCLUDING Vl=0 and Vl=V. At either
/// endpoint it supplies a conservative birth/exhaustion tangent. It is not a
/// nonequilibrium PZR closure, does not integrate and does not seed a phase.
pub fn equilibrium_chart(
    v: f64,
    vl: f64,
    lp: Point,
    gp: Point,
    saturation_slope: f64,
) -> Result<Equilibrium, Error> {
    volume(v)?;
    point(lp)?;
    point(gp)?;
    finite(&[vl, saturation_slope])?;
    if vl < 0.
        || vl > v
        || lp.pressure_pa != gp.pressure_pa
        || lp.temperature_k != gp.temperature_k
        || saturation_slope <= 0.
    {
        return Err(Error::InvalidInput("saturation chart"));
    }
    let vg = v - vl;
    let drl = lp.density_pressure + lp.density_temperature * saturation_slope;
    let drg = gp.density_pressure + gp.density_temperature * saturation_slope;
    let dul = lp.energy_pressure + lp.energy_temperature * saturation_slope;
    let dug = gp.energy_pressure + gp.energy_temperature * saturation_slope;
    let out = Equilibrium {
        mass_kg: vl * lp.density_kg_m3 + vg * gp.density_kg_m3,
        internal_energy_j: vl * lp.density_kg_m3 * lp.internal_energy_j_kg
            + vg * gp.density_kg_m3 * gp.internal_energy_j_kg,
        derivative: [
            vl * drl + vg * drg,
            lp.density_kg_m3 - gp.density_kg_m3,
            vl * (drl * lp.internal_energy_j_kg + lp.density_kg_m3 * dul)
                + vg * (drg * gp.internal_energy_j_kg + gp.density_kg_m3 * dug),
            lp.density_kg_m3 * lp.internal_energy_j_kg - gp.density_kg_m3 * gp.internal_energy_j_kg,
        ],
    };
    finite(&[out.mass_kg, out.internal_energy_j])?;
    finite(&out.derivative)?;
    Ok(out)
}

impl Equilibrium {
    /// Coordinate rates [p',Vl'] from actual signed M'/U', not a prescribed
    /// boiling curve. A direction pointing outside [0,V] switches to its actual
    /// pure-phase chart at the root; caller must not continue or clip it.
    pub fn rates(self, mass_rate_kg_s: f64, energy_rate_w: f64) -> Result<[f64; 2], Error> {
        finite(&[mass_rate_kg_s, energy_rate_w])?;
        let [mp, mv, ep, ev] = self.derivative;
        let determinant = mp * ev - mv * ep;
        if !determinant.is_finite() || determinant == 0. {
            return Err(Error::SingularChart);
        }
        let out = [
            (ev * mass_rate_kg_s - mv * energy_rate_w) / determinant,
            (mp * energy_rate_w - ep * mass_rate_kg_s) / determinant,
        ];
        finite(&out)?;
        Ok(out)
    }
}

//! Finite liquid-line storage and reciprocal current donor receipts.
//!
//! The primary, line and PZR keep their own thermodynamic pressures. Endpoint
//! currents are simultaneous unknowns, not prescribed successful delivery or a
//! pressure-matching initializer. This function supplies transport/storage
//! rows; mechanical endpoint forces must be composed separately.
use crate::{
    hot_spine::{Properties, WaterChart},
    thermal::Scalar,
};

#[derive(Clone, Copy, Debug)]
pub struct Liquid {
    pub mass: Scalar,
    pub enthalpy: Scalar,
    pub boron: Scalar,
}
impl Liquid {
    pub fn validate_accepted(self) -> Result<(), String> {
        check(self)?;
        if self.mass.value <= 0. || self.boron.value < 0. {
            return Err("inadmissible accepted surge liquid mass/tracer".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct State {
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub energy: Scalar,
    pub boron: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Rates {
    pub pressure: Scalar,
    pub energy: Scalar,
    pub boron: Scalar,
}
/// Positive signs enter the named finite owner. Boron is transported equivalent
/// absorber amount, not additional EOS mass or an extra caloric source.
#[derive(Clone, Copy, Debug, Default)]
pub struct Receipt {
    pub mass: Scalar,
    pub energy: Scalar,
    pub boron: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Evaluation {
    pub water: WaterChart,
    pub primary: Receipt,
    pub pzr_liquid: Receipt,
    pub line: Receipt,
    pub caloric: Scalar,
    pub continuity: Scalar,
    pub energy_residual: Scalar,
    pub boron_residual: Scalar,
    /// False at a zero-current donor switch with a nonzero current direction.
    pub linearizable: bool,
}
fn finite(x: Scalar) -> bool {
    x.value.is_finite() && x.direction.is_finite()
}
fn check(l: Liquid) -> Result<(), String> {
    if ![l.mass, l.enthalpy, l.boron].into_iter().all(finite) || l.mass.value == 0. {
        return Err("surge donor concentration requires a finite nonzero liquid amount".into());
    }
    Ok(())
}
fn negative(x: Receipt) -> Receipt {
    let minus = Scalar::constant(-1.);
    Receipt {
        mass: x.mass * minus,
        energy: x.energy * minus,
        boron: x.boron * minus,
    }
}
fn current(q: Scalar, from: Option<Liquid>, to: Option<Liquid>) -> Result<Receipt, String> {
    if q.value == 0. && q.direction == 0. {
        return Ok(Receipt::default());
    }
    let forward = q.value > 0. || (q.value == 0. && q.direction > 0.);
    let donor = if forward { from } else { to }
        .ok_or("surge liquid transport has no actual donor; phase arrival requires a phase line")?;
    check(donor)?;
    Ok(Receipt {
        mass: q,
        energy: q * donor.enthalpy,
        boron: q * donor.boron / donor.mass,
    })
}

/// `inlet` is primary→line and `outlet` line→PZR. The actual PZR liquid may be
/// absent on arrival; reverse withdrawal then refuses instead of inventing it.
/// A vapor/NC line is outside this function's explicitly liquid domain.
/// `heat` is actual external thermal receipt, never a pressure/friction heater.
#[allow(clippy::too_many_arguments)]
pub fn evaluate<P: Properties>(
    properties: &P,
    volume_m3: f64,
    x: State,
    d: Rates,
    primary: Liquid,
    pzr_liquid: Option<Liquid>,
    inlet: Scalar,
    outlet: Scalar,
    heat: Scalar,
) -> Result<Evaluation, String> {
    if !volume_m3.is_finite()
        || volume_m3 <= 0.
        || ![
            x.pressure,
            x.temperature,
            x.energy,
            x.boron,
            d.pressure,
            d.energy,
            d.boron,
            inlet,
            outlet,
            heat,
        ]
        .into_iter()
        .all(finite)
    {
        return Err("nonfinite or unavailable finite surge input".into());
    }
    check(primary)?;
    if let Some(pzr) = pzr_liquid {
        check(pzr)?;
    }
    let water = properties.fixed_liquid(volume_m3, x.pressure, x.temperature)?;
    let line_liquid = Liquid {
        mass: water.mass,
        enthalpy: water.projection.enthalpy,
        boron: x.boron,
    };
    check(line_liquid)?;
    let into = current(inlet, Some(primary), Some(line_liquid))?;
    let out = current(outlet, Some(line_liquid), pzr_liquid)?;
    let line = Receipt {
        mass: into.mass - out.mass,
        energy: into.energy - out.energy + heat,
        boron: into.boron - out.boron,
    };
    let result = Evaluation {
        water,
        primary: negative(into),
        pzr_liquid: out,
        line,
        caloric: x.energy - water.energy,
        continuity: water.projection.mass_p_at_energy * d.pressure
            + water.projection.mass_energy_at_pressure * d.energy
            - line.mass,
        energy_residual: d.energy - line.energy,
        boron_residual: d.boron - line.boron,
        linearizable: !((inlet.value == 0. && inlet.direction != 0.)
            || (outlet.value == 0. && outlet.direction != 0.)),
    };
    if ![
        result.line.mass,
        result.line.energy,
        result.line.boron,
        result.caloric,
        result.continuity,
        result.energy_residual,
        result.boron_residual,
    ]
    .into_iter()
    .all(finite)
    {
        return Err("nonfinite surge result".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: f64) -> Scalar {
        Scalar::constant(x)
    }
    fn liquid(mass: f64, enthalpy: f64, boron: f64) -> Liquid {
        Liquid {
            mass: s(mass),
            enthalpy: s(enthalpy),
            boron: s(boron),
        }
    }
    #[test]
    fn reversal_uses_its_actual_donor_without_equalizing_end_currents() {
        let hot = liquid(10., 1.5e6, 0.01);
        let line = liquid(3., 1.2e6, 0.006);
        let pzr = liquid(4., 1.4e6, 0.012);
        let a = current(s(2.), Some(hot), Some(line)).unwrap();
        let b = current(s(-3.), Some(line), Some(pzr)).unwrap();
        assert_eq!(a.energy.value, 3e6);
        assert_eq!(b.energy.value, -4.2e6);
        assert_eq!(a.boron.value, 0.002);
        assert_eq!(b.boron.value, -3. * (0.012 / 4.));
        let line_mass = a.mass - b.mass;
        assert_eq!(line_mass.value, 5.);
        assert_eq!((negative(a).mass + line_mass + b.mass).value, 0.);
    }
    #[test]
    fn exact_zero_does_not_query_absent_donor_and_switch_is_directional() {
        assert_eq!(current(s(0.), None, None).unwrap().energy.value, 0.);
        let from = liquid(1., 2., 0.1);
        let to = liquid(1., 5., 0.2);
        assert_eq!(
            current(Scalar::new(0., 3.), Some(from), Some(to))
                .unwrap()
                .energy
                .direction,
            6.
        );
        assert_eq!(
            current(Scalar::new(0., -3.), Some(from), Some(to))
                .unwrap()
                .energy
                .direction,
            -15.
        );
        assert!(current(s(-1.), Some(from), None).is_err());
    }
    #[test]
    fn complete_receipt_direction_contains_donor_state_and_current_changes() {
        let from = Liquid {
            mass: Scalar::new(3., 0.4),
            enthalpy: Scalar::new(7., -0.3),
            boron: Scalar::new(0.2, 0.01),
        };
        let q = Scalar::new(2., 0.5);
        let r = current(q, Some(from), None).unwrap();
        let shift = |x: Scalar, e: f64| s(x.value + e * x.direction);
        let sample = |e| {
            current(
                shift(q, e),
                Some(Liquid {
                    mass: shift(from.mass, e),
                    enthalpy: shift(from.enthalpy, e),
                    boron: shift(from.boron, e),
                }),
                None,
            )
            .unwrap()
        };
        let a = sample(1e-4);
        let b = sample(-1e-4);
        assert!((r.energy.direction - (a.energy.value - b.energy.value) / 2e-4).abs() < 1e-10);
        assert!((r.boron.direction - (a.boron.value - b.boron.value) / 2e-4).abs() < 1e-10);
    }
    #[test]
    fn signed_phase_trial_is_not_accepted_state_or_exact_absence() {
        let trial = liquid(-2., 3., 0.2);
        assert!(current(s(-1.), None, Some(trial)).is_ok());
        assert!(trial.validate_accepted().is_err());
        assert!(current(s(-1.), None, Some(liquid(0., 3., 0.2))).is_err());
        assert!(liquid(2., 3., 0.2).validate_accepted().is_ok());
        assert!(liquid(2., 3., -0.2).validate_accepted().is_err());
    }
}

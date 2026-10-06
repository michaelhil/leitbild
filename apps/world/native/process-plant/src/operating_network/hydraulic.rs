//! Current selected single-liquid friction families; no EOS or nested stock
//! recovery in the algebraic scalar flow solve. Physical turbulent/form losses
//! replace a laminar-only domain gate, not supplement already owned friction.
#[derive(Clone, Copy, Debug)]
pub enum LossLaw {
    EffectiveTotal,
    ChurchillPipe,
    ChurchillAnnulus,
    CoreBundle,
    GuideAnnulus { laminar_darcy: f64 },
    SmoothColebrook,
}

#[derive(Clone, Copy, Debug)]
pub struct Hydraulic {
    pub from: usize,
    pub to: usize,
    pub law: LossLaw,
    pub length: f64,
    pub flow_area: f64,
    pub diameter: f64,
    pub roughness: f64,
    /// Authored forms for detailed families; the complete retained effective
    /// quadratic budget for EffectiveTotal. Never add wall friction twice.
    pub fixed_loss: f64,
    /// Number of represented grids * factor * blockage^2, CoreBundle only.
    pub grid_multiplier: f64,
}
impl Hydraulic {
    /// Constitutive pressure loss and local q/mu/rho tangents, useful for
    /// diagnosed domain and stiffness receipts without a second flow law.
    pub fn pressure_loss(&self, q: f64, rho: f64, mu: f64) -> [f64; 4] {
        loss(self, q, rho, mu)
    }
}

fn churchill(re: f64, roughness: f64, diameter: f64, laminar: f64) -> f64 {
    // At Re<500 the turbulent term is below floating-point significance in
    // this formula; analytic laminar evaluation also avoids power overflow.
    if re < 500. {
        return laminar / re;
    }
    let a = (2.457
        * ((7. / re).powf(0.9) + 0.27 * roughness / diameter)
            .recip()
            .ln())
    .powi(16);
    let b = (37530. / re).powi(16);
    let low = (laminar / (8. * re)).powi(12);
    8. * (low + (a + b).powf(-1.5)).powf(1. / 12.)
}
fn coefficient(e: &Hydraulic, re: f64) -> f64 {
    let f = match e.law {
        LossLaw::EffectiveTotal => return (64. / re * e.length / e.diameter).max(e.fixed_loss),
        LossLaw::ChurchillPipe => churchill(re, e.roughness, e.diameter, 64.),
        LossLaw::ChurchillAnnulus => churchill(re, 0., e.diameter, 96.),
        LossLaw::CoreBundle => (64. / re)
            .max(1.691 * re.powf(-0.43))
            .max(0.117 * re.powf(-0.14)),
        LossLaw::GuideAnnulus { laminar_darcy } => {
            (laminar_darcy / re).max(churchill(re, e.roughness, e.diameter, 64.))
        }
        LossLaw::SmoothColebrook => {
            if re <= 2300. {
                64. / re
            } else {
                let mut x = 7.;
                for _ in 0..24 {
                    let residual = x + 2. * (2.51 * x / re).log10();
                    let next = x - residual / (1. + 2. / (x * std::f64::consts::LN_10));
                    if (next - x).abs() <= 1e-13 * x {
                        x = next;
                        break;
                    }
                    x = next;
                }
                // A cap is not successful root closure. NaN propagates to the
                // explicit selected-loss refusal, never a fallback factor.
                if !x.is_finite() || x <= 0. || (x + 2. * (2.51 * x / re).log10()).abs() > 1e-11 {
                    return f64::NAN;
                }
                let turbulent = 1. / (x * x);
                if re >= 4000. {
                    turbulent
                } else {
                    let w = (re - 2300.) / 1700.;
                    (1. - w) * 64. / re + w * turbulent
                }
            }
        }
    };
    let grids = if matches!(e.law, LossLaw::CoreBundle) {
        20_f64.min(196. * re.powf(-0.333)) * e.grid_multiplier
    } else {
        0.
    };
    f * e.length / e.diameter + e.fixed_loss + grids
}
fn laminar_coefficient(e: &Hydraulic) -> f64 {
    match e.law {
        LossLaw::ChurchillAnnulus => 96.,
        LossLaw::GuideAnnulus { laminar_darcy } => laminar_darcy,
        _ => 64.,
    }
}

/// Returns signed pressure loss, dloss/dq, dloss/dmu and dloss/drho.
pub fn loss(e: &Hydraulic, q: f64, rho: f64, mu: f64) -> [f64; 4] {
    let re = q.abs() * e.diameter / (e.flow_area * mu);
    if re == 0. {
        let r =
            laminar_coefficient(e) * mu * e.length / (2. * rho * e.flow_area * e.diameter.powi(2));
        return [0., r, 0., 0.];
    }
    let c = coefficient(e, re);
    let dc = if matches!(e.law, LossLaw::EffectiveTotal)
        && e.fixed_loss > 64. / re * e.length / e.diameter
    {
        0.
    } else if re < 0.1 {
        // All selected branches reduce exactly to their laminar term here.
        -laminar_coefficient(e) * e.length / (e.diameter * re * re)
    } else {
        let step = re * 1e-5;
        (coefficient(e, re + step) - coefficient(e, re - step)) / (2. * step)
    };
    let scale = q * q.abs() / (2. * rho * e.flow_area.powi(2));
    let value = scale * c;
    [
        value,
        q.abs() * (2. * c + re * dc) / (2. * rho * e.flow_area.powi(2)),
        scale * dc * (-re / mu),
        -value / rho,
    ]
}

/// Initialization-only inverse in the operating network. Advancing residuals
/// consume a signed algebraic q and evaluate `pressure_loss` forward instead.
pub fn flow(e: &Hydraulic, drive: f64, rho: f64, mu: f64) -> Result<(f64, [f64; 4]), String> {
    if drive == 0. {
        let d = loss(e, 0., rho, mu);
        return Ok((0., d));
    }
    let sign = drive.signum();
    let target = drive.abs();
    let r = laminar_coefficient(e) * mu * e.length / (2. * rho * e.flow_area * e.diameter.powi(2));
    let form = e.fixed_loss / (2. * rho * e.flow_area.powi(2));
    if matches!(e.law, LossLaw::EffectiveTotal) {
        let q = sign
            * if form > 0. {
                (target / r).min((target / form).sqrt())
            } else {
                target / r
            };
        let d = loss(e, q, rho, mu);
        if !q.is_finite() || !d.iter().all(|x| x.is_finite()) || d[1] <= 0. {
            return Err("Invalid effective total hydraulic loss".into());
        }
        return Ok((q, d));
    }
    let mut hi = 2. * target / (r + (r * r + 4. * form * target).sqrt());
    if !hi.is_finite() || hi <= 0. {
        return Err("Nonfinite viscous algebraic flow bracket".into());
    }
    // Selected added turbulence/grids make this viscous/form bound an upper
    // bracket; numerical rounding alone may require a tiny enlargement.
    if loss(e, hi, rho, mu)[0] < target {
        hi *= 1. + 1e-12;
    }
    let mut lo = 0.;
    let mut q = hi * 0.5;
    for _ in 0..64 {
        let d = loss(e, q, rho, mu);
        let defect = d[0] - target;
        if !d.iter().all(|x| x.is_finite()) || d[1] <= 0. {
            return Err("Nonmonotone/nonfinite selected hydraulic loss".into());
        }
        if defect.abs() <= target * 2e-13 {
            let q = sign * q;
            return Ok((q, loss(e, q, rho, mu)));
        }
        if defect > 0. {
            hi = q;
        } else {
            lo = q;
        }
        let next = q - defect / d[1];
        q = if next > lo && next <= hi {
            next
        } else {
            0.5 * (lo + hi)
        };
    }
    Err("Algebraic hydraulic flow did not close its pressure-loss residual".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_families_are_signed_monotone_and_close_actual_loss() {
        for law in [
            LossLaw::EffectiveTotal,
            LossLaw::ChurchillPipe,
            LossLaw::ChurchillAnnulus,
            LossLaw::CoreBundle,
            LossLaw::GuideAnnulus {
                laminar_darcy: 95.98,
            },
            LossLaw::SmoothColebrook,
        ] {
            let e = Hydraulic {
                from: 0,
                to: 1,
                law,
                length: 4.,
                flow_area: 0.5,
                diameter: 0.05,
                roughness: 2e-6,
                fixed_loss: 1.,
                grid_multiplier: 0.49,
            };
            let mut previous = 0.;
            for drive in [1e-12, 1e-8, 1e-4, 1., 100., 10000., 1e6] {
                let (q, d) = flow(&e, drive, 997., 0.001).unwrap();
                assert!(q > previous && d[1] > 0.);
                previous = q;
                assert!((d[0] - drive).abs() <= drive * 3e-13);
                let (reverse, rd) = flow(&e, -drive, 997., 0.001).unwrap();
                assert_eq!(reverse, -q);
                assert_eq!(rd[0], -d[0]);
            }
            let derivative = loss(&e, 0., 997., 0.001)[1];
            let expected =
                laminar_coefficient(&e) * 0.001 * 4. / (2. * 997. * 0.5 * 0.05_f64.powi(2));
            assert_eq!(derivative, expected);
            for re in [100., 10000., 1e6] {
                let q = re * e.flow_area * 0.001 / e.diameter;
                let base = loss(&e, q, 997., 0.001);
                for factor in [1., 0.5] {
                    let step = q * 1e-5 * factor;
                    let seen = (loss(&e, q + step, 997., 0.001)[0]
                        - loss(&e, q - step, 997., 0.001)[0])
                        / (2. * step);
                    assert!((seen - base[1]).abs() <= base[1].abs() * 1e-4 + 1e-10);
                    let dm = 0.001 * 1e-5 * factor;
                    let seen = (loss(&e, q, 997., 0.001 + dm)[0]
                        - loss(&e, q, 997., 0.001 - dm)[0])
                        / (2. * dm);
                    assert!((seen - base[2]).abs() <= base[2].abs() * 1e-4 + 1e-5);
                }
            }
        }
    }
    #[test]
    fn effective_total_high_fixed_loss_has_its_actual_low_re_tangent() {
        let e = Hydraulic {
            from: 0,
            to: 1,
            law: LossLaw::EffectiveTotal,
            length: 1.,
            flow_area: 1.,
            diameter: 0.1,
            roughness: 0.,
            fixed_loss: 1e9,
            grid_multiplier: 0.,
        };
        let q = 1e-4;
        let rho = 997.;
        let mu = 0.001;
        let d = loss(&e, q, rho, mu);
        assert_eq!(d[2], 0.);
        assert!((d[1] - q * 1e9 / rho).abs() < 1e-9);
    }
}

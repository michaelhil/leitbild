//! Selected single-liquid friction families, serial physical passages and the
//! local monotone variable-seat inverse. No nested thermodynamic stock recovery.
//! Turbulent/form losses replace a laminar-only domain gate, not supplement
//! already owned friction. Passage inertance is geometry, not an installed
//! acoustic or momentum state in the sound-filtered operating network.
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
pub struct HydraulicSegment {
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
impl HydraulicSegment {
    /// Mass-flow inertance, m^-1: I*qdot has pressure units. The compiled
    /// contact length partitions its actual passage, with no extra fluid stock.
    pub fn inertance(&self) -> f64 {
        self.length / self.flow_area
    }
    /// Constitutive pressure loss and local q/mu/rho tangents, useful for
    /// diagnosed domain and stiffness receipts without a second flow law.
    pub fn pressure_loss(&self, q: f64, rho: f64, mu: f64) -> [f64; 4] {
        loss(self, q, rho, mu)
    }
}

/// Serial physical half-passages sharing one signed connection flow. Each
/// actual bore/parallel area owns its own loss; no representative diameter or
/// duplicated effective header coefficient replaces the material geometry.
#[derive(Clone, Debug)]
pub struct Hydraulic {
    pub from: usize,
    pub to: usize,
    /// Physical connection elevations; thermal stocks retain their centroids.
    pub from_elevation: f64,
    pub to_elevation: f64,
    pub segments: Vec<HydraulicSegment>,
}

/// One selected variable seat. Actual q remains the global state coordinate;
/// bounded conductance flow u=q/a is only a local constitutive inverse variable.
#[derive(Clone, Copy, Debug)]
pub struct Seat {
    pub edge: usize,
    pub area: f64,
    pub full_open_loss: f64,
}
impl Seat {
    pub fn loss(self, u: f64, rho: f64) -> [f64; 3] {
        let coefficient = self.full_open_loss / (2. * rho * self.area * self.area);
        let value = coefficient * u * u.abs();
        [value, 2. * coefficient * u.abs(), -value / rho]
    }
    /// Exact local monotone restriction inverse, not a thermodynamic chart or
    /// a second time solver. Solve in bounded normalized conductance flow;
    /// actual q remains the global coordinate and is continuous at closure.
    /// Returns q and implicit head/mu/rho derivatives at fixed actual opening.
    pub fn flow(
        self,
        edge: &Hydraulic,
        head: f64,
        opening: f64,
        rho: f64,
        mu: f64,
    ) -> Result<[f64; 4], String> {
        if ![head, opening, rho, mu, self.area, self.full_open_loss]
            .iter()
            .all(|x| x.is_finite())
            || !(0.0..=1.0).contains(&opening)
            || rho <= 0.
            || mu <= 0.
            || self.area <= 0.
            || self.full_open_loss <= 0.
        {
            return Err("Invalid selected restriction input".into());
        }
        if opening == 0. {
            return Ok([0.; 4]);
        }
        if head == 0. {
            let lambda = edge.pressure_loss(0., rho, mu)[1];
            if !lambda.is_finite() || lambda <= 0. {
                return Err("Singular zero-head restriction".into());
            }
            return Ok([0., 1. / lambda, 0., 0.]);
        }
        let sign = head.signum();
        let bound = (2. * rho * self.area * self.area * head.abs() / self.full_open_loss).sqrt();
        if !bound.is_finite() || bound <= 0. {
            return Err("Unrepresentable restriction bracket".into());
        }
        let laminar = opening * edge.pressure_loss(0., rho, mu)[1];
        let root =
            2. * (self.full_open_loss * head.abs() / (2. * rho * self.area * self.area)).sqrt();
        let seed = root / (laminar + laminar.hypot(root));
        let (mut lo, mut hi, mut x) = (0., 1., seed);
        for _ in 0..64 {
            let u = sign * bound * x;
            let q = opening * u;
            let fixed = edge.pressure_loss(q, rho, mu);
            let valve = self.loss(u, rho);
            let residual = sign * (fixed[0] + valve[0]) - head.abs();
            let slope = opening * fixed[1] + valve[1];
            if !residual.is_finite() || !slope.is_finite() || slope <= 0. {
                return Err("Invalid monotone restriction slope".into());
            }
            if residual.abs() <= 2e-12 * head.abs() {
                return Ok([
                    q,
                    opening / slope,
                    -opening * fixed[2] / slope,
                    -opening * (fixed[3] + valve[2]) / slope,
                ]);
            }
            if residual > 0. {
                hi = x;
            } else {
                lo = x;
            }
            let next = x - residual / (bound * slope);
            x = if next > lo && next < hi {
                next
            } else {
                0.5 * (lo + hi)
            };
        }
        Err("Selected restriction inverse did not close".into())
    }
}
impl Hydraulic {
    pub fn inertance(&self) -> f64 {
        self.segments.iter().map(HydraulicSegment::inertance).sum()
    }
    pub fn pressure_loss(&self, q: f64, rho: f64, mu: f64) -> [f64; 4] {
        let mut result = [0.; 4];
        for segment in &self.segments {
            let part = segment.pressure_loss(q, rho, mu);
            for i in 0..4 {
                result[i] += part[i];
            }
        }
        result
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
fn coefficient(e: &HydraulicSegment, re: f64) -> f64 {
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
fn laminar_coefficient(e: &HydraulicSegment) -> f64 {
    match e.law {
        LossLaw::ChurchillAnnulus => 96.,
        LossLaw::GuideAnnulus { laminar_darcy } => laminar_darcy,
        _ => 64.,
    }
}

/// Returns signed pressure loss, dloss/dq, dloss/dmu and dloss/drho.
pub fn loss(e: &HydraulicSegment, q: f64, rho: f64, mu: f64) -> [f64; 4] {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_flow_inverse_is_continuous_from_closed_and_handles_real_heads_and_reversal() {
        let edge = Hydraulic {
            from: 0,
            to: 1,
            from_elevation: 0.,
            to_elevation: 0.,
            segments: vec![HydraulicSegment {
                law: LossLaw::ChurchillPipe,
                length: 0.6,
                flow_area: std::f64::consts::PI * 0.5_f64.powi(2) / 4.,
                diameter: 0.5,
                roughness: 15e-6,
                fixed_loss: 0.,
                grid_multiplier: 0.,
            }],
        };
        let seat = Seat {
            edge: 0,
            area: edge.segments[0].flow_area,
            full_open_loss: 4.4,
        };
        let (rho, mu) = (998., 0.001);
        for opening in [0., 1e-12, 1e-8, 0.001, 0.2, 1.] {
            for head in [-20000., -1., -1e-9, 0., 1e-9, 1., 20000.] {
                let r = seat.flow(&edge, head, opening, rho, mu).unwrap();
                assert!(r.iter().all(|x| x.is_finite()));
                if opening == 0. {
                    assert_eq!(r, [0.; 4]);
                    continue;
                }
                if head == 0. {
                    assert_eq!(r[0], 0.);
                    assert!(r[1] > 0.);
                    continue;
                }
                let physical =
                    edge.pressure_loss(r[0], rho, mu)[0] + seat.loss(r[0] / opening, rho)[0];
                assert!(
                    (physical - head).abs() < 3e-12 * head.abs(),
                    "a{opening} head{head} receipt{physical}"
                );
                assert_eq!(r[0].signum(), head.signum());
                assert!(r[1] > 0.);
                // The global residual is q-Q: an arbitrary prior closed q=0
                // obtains the exact held-head flow in ONE Newton correction.
                let old = 0.;
                let residual = old - r[0];
                let updated = old - residual;
                assert_eq!(updated, r[0]);
                let h = head.abs() * 1e-4;
                let plus = seat.flow(&edge, head + h, opening, rho, mu).unwrap()[0];
                let minus = seat.flow(&edge, head - h, opening, rho, mu).unwrap()[0];
                let numeric = (plus - minus) / (2. * h);
                assert!((numeric - r[1]).abs() < 1e-5 * r[1]);
            }
        }
        assert!(seat.flow(&edge, 1., -0.001, rho, mu).is_err());
    }
    #[test]
    fn unlike_serial_half_passages_preserve_actual_bores_and_sum_all_tangents() {
        let a = HydraulicSegment {
            law: LossLaw::ChurchillPipe,
            length: 2.,
            flow_area: 0.2,
            diameter: 0.05,
            roughness: 1e-5,
            fixed_loss: 0.5,
            grid_multiplier: 0.,
        };
        let b = HydraulicSegment {
            length: 7.,
            flow_area: 0.6,
            diameter: 0.4,
            fixed_loss: 2.,
            ..a
        };
        let edge = Hydraulic {
            from: 0,
            to: 1,
            from_elevation: 0.,
            to_elevation: 0.,
            segments: vec![a, b],
        };
        assert_eq!(edge.inertance(), a.inertance() + b.inertance());
        for q in [-100., -0.001, 0., 0.001, 100.] {
            let full = edge.pressure_loss(q, 997., 0.001);
            let aa = a.pressure_loss(q, 997., 0.001);
            let bb = b.pressure_loss(q, 997., 0.001);
            for i in 0..4 {
                assert_eq!(full[i], aa[i] + bb[i]);
            }
            assert!(full[1] > 0.);
            let dq = 1e-7 * q.abs().max(1.);
            let fd = (edge.pressure_loss(q + dq, 997., 0.001)[0]
                - edge.pressure_loss(q - dq, 997., 0.001)[0])
                / (2. * dq);
            assert!((fd - full[1]).abs() <= 1e-5 * full[1].abs() + 1e-9);
        }
    }
    #[test]
    fn selected_families_have_signed_monotone_forward_loss_and_actual_tangents() {
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
            let e = HydraulicSegment {
                law,
                length: 4.,
                flow_area: 0.5,
                diameter: 0.05,
                roughness: 2e-6,
                fixed_loss: 1.,
                grid_multiplier: 0.49,
            };
            let mut previous = 0.;
            for q in [1e-12, 1e-8, 1e-4, 1., 100., 10000., 1e6] {
                let d = loss(&e, q, 997., 0.001);
                assert!(d.iter().all(|v| v.is_finite()));
                assert!(d[0] > previous && d[1] > 0.);
                previous = d[0];
                let rd = loss(&e, -q, 997., 0.001);
                assert_eq!(rd[0], -d[0]);
                assert_eq!(rd[1], d[1]);
                assert_eq!(rd[2], -d[2]);
                assert_eq!(rd[3], -d[3]);
            }
            assert_eq!(e.inertance(), 8.);
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
        let e = HydraulicSegment {
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

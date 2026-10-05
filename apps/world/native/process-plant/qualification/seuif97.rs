//! Standalone OFFLINE candidate probe, not linked into the numerical component.
//! Its temporary Cargo project pins seuif97=2.3.8; no runtime backend switch.
use seuif97::*;

fn tuple(t: f64, x: f64, mode: &str) -> Result<[f64; 13], &'static str> {
    if !t.is_finite() || !x.is_finite() || t <= 0. || x <= 0. {
        return Err("Invalid finite positive input");
    }
    let celsius = t - 273.15;
    let (region, density) = match mode {
        "liquid" => {
            if !(273.15..647.096).contains(&t)
                || !(611.212677444..22.064e6).contains(&x)
                || t > px(x * 1e-6, 0., OT) + 273.15
            {
                return Err("Outside current stable subcritical liquid scope");
            }
            if t <= 623.15 {
                (1, pt(x * 1e-6, celsius, (OD, 1)))
            } else {
                // Backward density is a guess only. Refine the SAME R3 fundamental
                // potential through its public tv route; never mix pt/tv properties.
                let mut rho = pt(x * 1e-6, celsius, (OD, 3));
                for _ in 0..16 {
                    let p = tv(celsius, 1. / rho, (OP, 3)) * 1e6;
                    let kappa = tv(celsius, 1. / rho, (OKT, 3)) * 1e-6;
                    if !rho.is_finite()
                        || rho <= 322.
                        || !p.is_finite()
                        || !kappa.is_finite()
                        || kappa <= 0.
                    {
                        return Err("Invalid stable R3 density chart");
                    }
                    if (p - x).abs() <= 1e-3 {
                        break;
                    }
                    rho -= (p - x) * rho * kappa;
                }
                let p = tv(celsius, 1. / rho, (OP, 3)) * 1e6;
                if !rho.is_finite() || rho <= 322. || !p.is_finite() || (p - x).abs() > 1. {
                    return Err("R3 forward-pressure defect exceeds existing 1 Pa ceiling");
                }
                (3, rho)
            }
        }
        // Published potential verification only, NOT a wider admitted liquid API.
        "r1" => (1, pt(x * 1e-6, celsius, (OD, 1))),
        "r3" => (3, x),
        _ => return Err("Unknown private qualification mode"),
    };
    let property = |id| {
        if region == 1 {
            pt(x * 1e-6, celsius, (id, 1))
        } else {
            tv(celsius, 1. / density, (id, 3))
        }
    };
    let values = [
        property(OP) * 1e6,
        t,
        density,
        property(OU) * 1000.,
        property(OH) * 1000.,
        property(OS) * 1000.,
        property(OCP) * 1000.,
        property(OCV) * 1000.,
        property(OW),
        property(OEC),
        property(OKT) * 1e-6,
        property(ODV),
        property(OTC),
    ];
    if !values.iter().all(|v| v.is_finite())
        || [2, 6, 7, 8, 10, 11, 12].iter().any(|i| values[*i] <= 0.)
        || values[10] - t * values[9].powi(2) / (density * values[6]) <= 0.
    {
        return Err("Invalid complete candidate tuple");
    }
    Ok(values)
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!(
        args.len().is_multiple_of(3),
        "Expected mode,T,pressure-or-density triples"
    );
    for args in args.chunks_exact(3) {
        let t = args[1].parse().expect("Numeric T");
        let x = args[2].parse().expect("Numeric pressure/density");
        let values = tuple(t, x, &args[0]).expect("Candidate qualification query failed");
        println!("{{\"kind\":\"{}\",\"values\":{values:?}}}", args[0]);
    }
}

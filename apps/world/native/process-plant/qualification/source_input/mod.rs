//! Strict shared reader for the existing composed source qualification payload.
//! No numerical policy or alternate model; the advancing driver also consumes
//! raw geometry/layers so every collision update reaches the same transport law.
#![allow(dead_code)]
use super::{
    converter_heat, cylindrical_source, fuel_source, moderator_source, optical_source,
    passive_source, transport_source,
};
pub(crate) type Words<'a> = std::iter::Copied<std::slice::Iter<'a, &'a str>>;
pub(crate) fn number(w: &mut Words<'_>) -> f64 {
    let x: f64 = w
        .next()
        .expect("Missing number")
        .parse()
        .expect("Invalid number");
    assert!(x.is_finite(), "Nonfinite fixture");
    x
}
pub(crate) fn count(w: &mut Words<'_>) -> usize {
    let x = w
        .next()
        .expect("Missing count")
        .parse()
        .expect("Invalid count");
    x
}
pub(crate) fn array<const N: usize>(w: &mut Words<'_>) -> [f64; N] {
    std::array::from_fn(|_| number(w))
}
pub(crate) fn framed<'a>(w: &mut Words<'a>) -> Vec<&'a str> {
    let n = count(w);
    assert!(n <= w.len(), "Frame exceeds remaining fixture tokens");
    w.by_ref().take(n).collect()
}
pub(crate) fn near(a: f64, b: f64, scale: f64) {
    assert!(
        (a - b).abs() <= 3e-10 * scale.max(1e-300),
        "Independent number identity {a} != {b}, scale {scale}"
    );
}
fn fuel(
    tokens: &[&str],
) -> (
    fuel_source::FuelModel,
    Vec<fuel_source::Stocks>,
    Vec<f64>,
    f64,
) {
    use fuel_source::*;
    let mut w = tokens.iter().copied();
    let nr = count(&mut w);
    let ns = count(&mut w);
    let nq = count(&mut w);
    let ni = count(&mut w);
    assert!(
        [nr, ns, nq, ni].iter().all(|x| *x <= tokens.len()),
        "Fuel size exceeds payload"
    );
    let law = FuelLaw {
        absorption: array(&mut w),
        fission: array(&mut w),
        scatter: std::array::from_fn(|_| array(&mut w)),
        nu: array(&mut w),
        chi: array(&mut w),
        speed: array(&mut w),
        beta: array(&mut w),
        decay: array(&mut w),
        f_d: number(&mut w),
    };
    let rv = (0..nr).map(|_| number(&mut w)).collect();
    let sv = (0..ns).map(|_| number(&mut w)).collect();
    let cohorts = (0..nq)
        .map(|_| Cohort {
            segment: count(&mut w),
            mass: number(&mut w),
            mu: number(&mut w),
        })
        .collect();
    let intersections = (0..ni)
        .map(|_| {
            let region = count(&mut w);
            let segment = count(&mut w);
            let volume = number(&mut w);
            let nw = count(&mut w);
            assert!(nw <= w.len(), "Weights exceed remaining fixture");
            let weights = (0..nw)
                .map(|_| Weight {
                    cohort: count(&mut w),
                    mass: number(&mut w),
                })
                .collect();
            Intersection {
                region,
                segment,
                volume,
                weights,
            }
        })
        .collect();
    let stocks = (0..ns)
        .map(|_| Stocks {
            reserve: number(&mut w),
            reference_reserve: number(&mut w),
            fertile: number(&mut w),
            reference_fertile: number(&mut w),
        })
        .collect();
    let temperatures = (0..nq).map(|_| number(&mut w)).collect();
    let prompt = number(&mut w);
    assert!(prompt >= 0.);
    assert!(w.next().is_none(), "Trailing fuel fixture");
    (
        FuelModel::new(law, rv, sv, cohorts, intersections).unwrap(),
        stocks,
        temperatures,
        prompt,
    )
}
fn moderator(
    tokens: &[&str],
) -> (
    moderator_source::ModeratorModel,
    Vec<moderator_source::Stocks>,
) {
    use moderator_source::*;
    let mut w = tokens.iter().copied();
    let nr = count(&mut w);
    let ni = count(&mut w);
    assert!(
        nr <= tokens.len() && ni <= tokens.len(),
        "Moderator size exceeds payload"
    );
    let law = ModeratorLaw {
        absorption: array(&mut w),
        scatter: std::array::from_fn(|_| array(&mut w)),
        speed: array(&mut w),
        boron_sigma: array(&mut w),
        reference_density: number(&mut w),
        hydrogen_emission: array(&mut w),
        boron_emission: array(&mut w),
    };
    let volumes = (0..nr).map(|_| number(&mut w)).collect();
    let mut intersections = Vec::new();
    let mut stocks = Vec::new();
    for _ in 0..ni {
        intersections.push(Intersection {
            region: count(&mut w),
            volume: number(&mut w),
        });
        stocks.push(Stocks {
            water_mass: number(&mut w),
            liquid_volume: number(&mut w),
            hydrogen_target: number(&mut w),
            hydrogen_product: number(&mut w),
            mobile_boron10: number(&mut w),
        });
    }
    assert!(w.next().is_none(), "Trailing moderator fixture");
    (
        ModeratorModel::new(law, volumes, intersections).unwrap(),
        stocks,
    )
}

pub(crate) struct Input {
    pub fuel: fuel_source::FuelModel,
    pub stocks: Vec<fuel_source::Stocks>,
    pub temperatures: Vec<f64>,
    pub prompt: f64,
    pub moderator: moderator_source::ModeratorModel,
    pub water: Vec<moderator_source::Stocks>,
    pub nt: usize,
    pub amounts: Vec<f64>,
    pub emissions: Vec<[f64; 2]>,
    pub passive_stocks: Vec<passive_source::Stock>,
    pub passive_incidence: Vec<passive_source::Intersection>,
    pub nr: usize,
    pub nf: usize,
    pub speed: [f64; 7],
    pub escape_faces: usize,
    pub optical_faces: usize,
    pub optical_inputs: Vec<transport_source::OpticalInput>,
    pub optical_layers: Vec<Vec<optical_source::Layer>>,
    pub faces: Vec<transport_source::Face>,
    pub ell: Vec<f64>,
    pub supplied: Vec<[f64; 7]>,
    pub nc: usize,
    pub cylinders: Vec<cylindrical_source::Target>,
    pub nci: usize,
    pub cylinder_incidence: Vec<cylindrical_source::Intersection>,
    pub converter_index: usize,
    pub converter_model: converter_heat::Model,
    pub converter_liquid: converter_heat::LiquidPath,
    pub cylinder: cylindrical_source::Model,
    pub passive: passive_source::Model,
    pub transport: transport_source::Model,
    pub fuel_tokens: Vec<String>,
}
pub(crate) fn parse(tokens: &[&str]) -> Input {
    let mut w = tokens.iter().copied();
    let ft = framed(&mut w);
    let mt = framed(&mut w);
    let (fuel, stocks, temperatures, prompt) = fuel(&ft);
    let (moderator, water) = moderator(&mt);
    let nt = count(&mut w);
    let amounts = (0..nt).map(|_| number(&mut w)).collect::<Vec<_>>();
    let emissions = (0..nt).map(|_| array::<2>(&mut w)).collect::<Vec<_>>();
    let ns = count(&mut w);
    let passive_stocks = (0..ns)
        .map(|_| {
            let volume = number(&mut w);
            let scatter_m1 = array(&mut w);
            let n_targets = count(&mut w);
            let targets = (0..n_targets)
                .map(|_| passive_source::Target {
                    index: count(&mut w),
                    sigma_m2: array(&mut w),
                })
                .collect();
            passive_source::Stock {
                volume,
                scatter_m1,
                targets,
            }
        })
        .collect::<Vec<_>>();
    let ni = count(&mut w);
    let passive_incidence = (0..ni)
        .map(|_| passive_source::Intersection {
            stock: count(&mut w),
            region: count(&mut w),
            volume: number(&mut w),
        })
        .collect::<Vec<_>>();
    let nr = count(&mut w);
    let nf = count(&mut w);
    assert!(
        nr <= w.len() && nf <= w.len(),
        "Transport size exceeds payload"
    );
    let speed: [f64; 7] = array(&mut w);
    let volumes = (0..nr).map(|_| number(&mut w)).collect::<Vec<_>>();
    let ell = (0..nr).map(|_| number(&mut w)).collect::<Vec<_>>();
    assert_eq!(volumes, fuel.volumes(), "Fuel region map mismatch");
    assert_eq!(
        volumes,
        moderator.volumes(),
        "Moderator region map mismatch"
    );
    assert_eq!(speed, fuel.law().speed);
    assert_eq!(speed, moderator.law().speed);
    let mut escape_faces = 0;
    let mut optical_inputs = Vec::new();
    let mut optical_faces = 0;
    let mut optical_layers = Vec::new();
    let faces: Vec<_> = (0..nf)
        .map(|_| {
            let left = count(&mut w);
            let right: isize = w
                .next()
                .expect("Missing face right")
                .parse()
                .expect("Invalid face right");
            let area = number(&mut w);
            let left_distance = number(&mut w);
            let rd = number(&mut w);
            let nl = count(&mut w);
            let response = if nl > 0 {
                assert!(right >= 0, "Optical exterior unsupported");
                let layers = (0..nl)
                    .map(|_| {
                        let nc = count(&mut w);
                        optical_source::Layer {
                            columns: (0..nc)
                                .map(|_| optical_source::Column {
                                    target: count(&mut w),
                                    atoms_per_m2: number(&mut w),
                                    sigma_m2: array(&mut w),
                                })
                                .collect(),
                        }
                    })
                    .collect::<Vec<_>>();
                let response = optical_source::layer_response(&layers).unwrap();
                optical_layers.push(layers);
                Some(response)
            } else {
                None
            };
            assert!(right >= -1, "Invalid exterior index");
            let (right, right_distance, law) = if right == -1 {
                escape_faces += 1;
                assert_eq!(rd, 0.);
                (None, None, transport_source::FaceLaw::Escape)
            } else {
                let law = if let Some(response) = response {
                    optical_faces += 1;
                    optical_inputs.push(response.input);
                    transport_source::FaceLaw::Optical {
                        targets: response.targets,
                    }
                } else {
                    transport_source::FaceLaw::Transparent
                };
                (Some(right as usize), Some(rd), law)
            };
            transport_source::Face {
                left,
                right,
                area,
                left_distance,
                right_distance,
                law,
            }
        })
        .collect();
    let supplied = (0..nr).map(|_| array::<7>(&mut w)).collect::<Vec<_>>();
    let nc = count(&mut w);
    let cylinders = (0..nc)
        .map(|_| cylindrical_source::Target {
            index: count(&mut w),
            inner_radius: number(&mut w),
            outer_radius: number(&mut w),
            length: number(&mut w),
            multiplicity: count(&mut w),
            sigma_m2: array(&mut w),
            escape_depth: number(&mut w),
            collection: number(&mut w),
        })
        .collect::<Vec<_>>();
    let nci = count(&mut w);
    let cylinder_incidence = (0..nci)
        .map(|_| cylindrical_source::Intersection {
            target: count(&mut w),
            region: count(&mut w),
            share: number(&mut w),
        })
        .collect::<Vec<_>>();
    let converter_index = count(&mut w);
    let converter_model = converter_heat::Model::new(
        converter_heat::Geometry {
            film_thickness: number(&mut w),
            film_density: number(&mut w),
            film_mu_en: number(&mut w),
            carrier_wall: number(&mut w),
            thimble_wall: number(&mut w),
            steel_density: number(&mut w),
            steel_mu_en: number(&mut w),
        },
        number(&mut w),
        number(&mut w),
    )
    .unwrap();
    let converter_liquid = converter_heat::LiquidPath {
        density: number(&mut w),
        mu_en: number(&mut w),
        chord: number(&mut w),
    };
    assert!(w.next().is_none(), "Trailing composed payload");
    assert!(converter_index < nt && nc > 1 && nci > 0);
    assert_eq!(
        cylinders
            .iter()
            .filter(|q| q.index == converter_index && q.escape_depth > 0.)
            .count(),
        1
    );
    let cylinder = cylindrical_source::Model::new(
        volumes.clone(),
        speed,
        cylinders.clone(),
        cylinder_incidence.clone(),
        nt,
    )
    .unwrap();
    let passive = passive_source::Model::new(
        volumes.clone(),
        speed,
        passive_stocks.clone(),
        passive_incidence.clone(),
        nt,
    )
    .unwrap();
    let transport =
        transport_source::Model::new(volumes, ell.clone(), speed, faces.clone(), nt).unwrap();

    Input {
        fuel,
        stocks,
        temperatures,
        prompt,
        moderator,
        water,
        nt,
        amounts,
        emissions,
        passive_stocks,
        passive_incidence,
        nr,
        nf,
        speed,
        escape_faces,
        optical_faces,
        optical_inputs,
        supplied,
        nc,
        cylinders,
        nci,
        cylinder_incidence,
        converter_index,
        converter_model,
        converter_liquid,
        cylinder,
        passive,
        transport,
        ell,
        faces,
        optical_layers,
        fuel_tokens: ft.iter().map(|s| (*s).to_owned()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_frames_retain_remainder() {
        let tokens = ["2", "3", "4", "9"];
        let mut words = tokens.iter().copied();
        assert_eq!(framed(&mut words), ["3", "4"]);
        assert_eq!(count(&mut words), 9);
        assert!(words.next().is_none());
    }
    #[test]
    #[should_panic(expected = "Frame exceeds remaining")]
    fn oversized_frame_is_not_truncated() {
        let tokens = ["2", "3"];
        framed(&mut tokens.iter().copied());
    }
    #[test]
    #[should_panic(expected = "Nonfinite")]
    fn nonfinite_number_is_not_admitted() {
        number(&mut ["NaN"].iter().copied());
    }
}

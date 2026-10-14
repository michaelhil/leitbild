//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#trial-and-accepted-states
//! The saturation seam of the maintained property boundary. `Tsat(p)` and
//! `psat(T)` are not exact inverses, so a state a few ulps on the stable side
//! of saturation (by temperature) could compare as the other phase in the TP
//! region search and be refused, and a direction along the saturation line
//! at a saturated endpoint had both of its coefficient probes on the
//! metastable side. The boundary now evaluates such a state on its branch's
//! own region equation (no band, no tolerance), and probes such a direction
//! on the branch's admitted metastable states inside the band only.
use leitbild_operating_water::{Branch, CaloricLinearization, point};

/// The saturated endpoint's own internal energy on `branch`'s side.
fn endpoint_u(branch: Branch, p: f64) -> f64 {
    let saturated = match branch {
        Branch::Liquid => Branch::SaturatedLiquid,
        _ => Branch::SaturatedVapor,
    };
    point(saturated, p, 0.).unwrap().internal_energy_j_kg
}
fn tsat(p: f64) -> f64 {
    point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k
}
/// `u` and its `count` representable neighbours on each side; below the
/// band only the stable side's (no metastable state is admitted there).
fn neighbours(branch: Branch, p: f64, u: f64, count: usize) -> Vec<f64> {
    let (mut lo, mut hi) = (u, u);
    let mut out = vec![u];
    let banded = p > 2e6;
    for _ in 0..count {
        lo = lo.next_down();
        hi = hi.next_up();
        let liquid = matches!(branch, Branch::Liquid);
        if banded || liquid {
            out.push(lo);
        }
        if banded || !liquid {
            out.push(hi);
        }
    }
    out
}

/// Inside the band (2 < p <= 16 MPa) and below it.
const PRESSURES: [f64; 10] = [
    1e6,
    2.5e6,
    5e6,
    9e6,
    10e6,
    10_924_987.115_115_894,
    11e6,
    12e6,
    15e6,
    16e6,
];

#[test]
fn targets_beside_a_saturated_endpoint_are_recovered_on_their_branch() {
    for p in PRESSURES {
        for branch in [Branch::Liquid, Branch::Vapor] {
            for u in neighbours(branch, p, endpoint_u(branch, p), 16) {
                let q = CaloricLinearization::internal_energy(branch, p, u)
                    .unwrap_or_else(|e| panic!("{branch:?} p={p} u={u}: {e:?}"))
                    .point();
                assert!(
                    (q.temperature_k - tsat(p)).abs() < 1e-6,
                    "{branch:?} p={p} u={u}: T={}",
                    q.temperature_k
                );
            }
        }
    }
}

#[test]
fn the_endpoint_inverts_to_the_endpoint() {
    for p in PRESSURES {
        for branch in [Branch::Liquid, Branch::Vapor] {
            let q = CaloricLinearization::internal_energy(branch, p, endpoint_u(branch, p))
                .unwrap()
                .point();
            assert_eq!(q.temperature_k, tsat(p), "{branch:?} p={p}");
        }
    }
}

/// `(dp, du)` along the saturation line at the endpoint, at unit and solver
/// magnitudes, and the coordinate directions.
fn directions(branch: Branch, p: f64) -> Vec<(f64, f64)> {
    // Inward at the 16 MPa vapor ceiling.
    let h = p * 1e-6;
    let along = (endpoint_u(branch, p) - endpoint_u(branch, p - h)) / h;
    vec![
        (1., along),
        (1.4e7, 1.4e7 * along),
        (-1.4e7, -1.4e7 * along),
        (1., 0.),
        (0., 1.),
    ]
}

#[test]
fn saturation_line_directions_at_an_endpoint_are_admitted_inside_the_band() {
    for p in PRESSURES.into_iter().filter(|p| *p > 2e6) {
        for branch in [Branch::Liquid, Branch::Vapor] {
            for u in neighbours(branch, p, endpoint_u(branch, p), 4) {
                let held = CaloricLinearization::internal_energy(branch, p, u).unwrap();
                for (dp, du) in directions(branch, p) {
                    let d = held
                        .directional(dp, du)
                        .unwrap_or_else(|e| panic!("{branch:?} p={p} u={u} d=({dp},{du}): {e:?}"));
                    assert!(d.cp_j_kg_k.is_finite() && d.compressibility_per_pa.is_finite());
                }
            }
        }
    }
}

#[test]
fn below_the_band_a_liquid_saturation_line_direction_still_refuses() {
    // Tsat is concave in p, so both probes of a direction along the
    // saturation line lie above it: the liquid's metastable side, which no
    // band admits at p <= 2 MPa (the vapor's are on its stable side).
    let p = 1e6;
    let held =
        CaloricLinearization::internal_energy(Branch::Liquid, p, endpoint_u(Branch::Liquid, p))
            .unwrap();
    let (dp, du) = directions(Branch::Liquid, p)[0];
    assert!(held.directional(dp, du).is_err());
    assert!(held.directional(1., 0.).is_ok() && held.directional(0., 1.).is_ok());
    let vapor =
        CaloricLinearization::internal_energy(Branch::Vapor, p, endpoint_u(Branch::Vapor, p))
            .unwrap();
    let (dp, du) = directions(Branch::Vapor, p)[0];
    assert!(vapor.directional(dp, du).is_ok());
}

//! Four strictly framed, owner-authored inputs for the offline source advance.
//! The first two frames preserve the existing source and fuel-history formats.
use super::{fuel_history, heat_history, source_evolution, source_input};
use source_input::{array, count, framed, near, number};

pub(crate) struct Prepared {
    pub input: source_evolution::Input,
    pub target_emissions: Vec<[f64; 2]>,
    pub cf_decay_rate: f64,
    pub neutron_coordinates: usize,
    pub segments: usize,
    pub water_owners: usize,
    pub targets: usize,
    pub mn_targets: usize,
}

pub(crate) fn parse(text: &str) -> Prepared {
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    let mut words = tokens.iter().copied();
    let source_tokens = framed(&mut words);
    let history_tokens = framed(&mut words);
    let water_tokens = framed(&mut words);
    let mn_tokens = framed(&mut words);
    assert!(words.next().is_none(), "Trailing evolution payload");
    let source = source_input::parse(&source_tokens);
    let mut h = history_tokens.iter().copied();
    let repeated_fuel = framed(&mut h);
    assert_eq!(
        repeated_fuel.len(),
        source.fuel_tokens.len(),
        "Repeated fuel frame length"
    );
    assert!(
        repeated_fuel
            .iter()
            .zip(&source.fuel_tokens)
            .all(|(a, b)| *a == b),
        "Repeated fuel preparation differs"
    );
    let ns = count(&mut h);
    assert_eq!(ns, source.fuel.segment_count());
    let segments = (0..ns)
        .map(|s| {
            let p = fuel_history::SegmentPreparation {
                reference_u235: number(&mut h),
                reference_u238: number(&mut h),
                sf235_neutrons_per_second: number(&mut h),
                sf238_neutrons_per_second: number(&mut h),
            };
            assert_eq!(p.reference_u235, source.stocks[s].reserve);
            assert_eq!(p.reference_u235, source.stocks[s].reference_reserve);
            assert_eq!(p.reference_u238, source.stocks[s].fertile);
            assert_eq!(p.reference_u238, source.stocks[s].reference_fertile);
            p
        })
        .collect();
    let poison = fuel_history::PoisonLaw {
        yield_i: number(&mut h),
        yield_xe: number(&mut h),
        yield_pm: number(&mut h),
        lambda_i: number(&mut h),
        lambda_xe: number(&mut h),
        lambda_pm: number(&mut h),
        xe_sigma_m2: number(&mut h),
        sm_sigma_m2: number(&mut h),
    };
    let ng = count(&mut h);
    assert_eq!(ng, 25, "Selected retained heat-history group count");
    let fission_energy = number(&mut h);
    let groups = (0..ng)
        .map(|_| heat_history::Group {
            feed: match count(&mut h) {
                0 => heat_history::Feed::Fission,
                1 => heat_history::Feed::FertileCapture,
                _ => panic!("Unknown heat-history feed"),
            },
            energy_per_event: number(&mut h),
            decay_rate: number(&mut h),
        })
        .collect::<Vec<_>>();
    near(
        source.prompt
            + groups
                .iter()
                .filter(|g| matches!(g.feed, heat_history::Feed::Fission))
                .map(|g| g.energy_per_event)
                .sum::<f64>(),
        fission_energy,
        fission_energy,
    );
    let multiplicity = number(&mut h);
    let cf = fuel_history::CfLaw {
        initial_energy_j: number(&mut h),
        initial_neutrons_per_second: number(&mut h),
        decay_rate: number(&mut h),
        birth_export_j_per_neutron: number(&mut h),
    };
    let support_count = count(&mut h);
    assert!(
        support_count <= h.len(),
        "Cf support exceeds remaining frame"
    );
    let support = (0..support_count)
        .map(|_| (count(&mut h), number(&mut h)))
        .collect();
    assert!(h.next().is_none(), "Trailing fuel-history frame");
    let history = fuel_history::Assembly::new(
        source.fuel,
        segments,
        poison,
        heat_history::Kernel::new(groups, fission_energy).unwrap(),
        multiplicity,
        cf,
        support,
    )
    .unwrap();
    let mut w = water_tokens.iter().copied();
    let no = count(&mut w);
    assert!(no <= w.len(), "Water owner count exceeds frame");
    let water_owners = (0..no)
        .map(|_| {
            let [hydrogen, hydrogen_product, boron, boron_product] = array(&mut w);
            source_evolution::WaterOwner {
                authority: source_evolution::WaterAuthority::Closed,
                hydrogen,
                hydrogen_product,
                boron,
                boron_product,
            }
        })
        .collect();
    let nr = count(&mut w);
    assert_eq!(nr, source.water.len(), "Water projection row count");
    let row_map = (0..nr)
        .map(|_| source_evolution::WaterRow {
            owner: count(&mut w),
            h_fraction: number(&mut w),
            b_fraction: number(&mut w),
        })
        .collect();
    assert!(w.next().is_none(), "Trailing water-owner frame");
    let mut m = mn_tokens.iter().copied();
    let nm = count(&mut m);
    assert!(nm <= m.len(), "Mn target count exceeds frame");
    let mn = (0..nm)
        .map(|_| source_evolution::MnTarget {
            target: count(&mut m),
            decay_rate: number(&mut m),
            electron_j: number(&mut m),
            photon_j: number(&mut m),
        })
        .collect();
    assert!(m.next().is_none(), "Trailing Mn frame");
    let neutron_coordinates = source.nr * 7;
    let targets = source.nt;
    let input = source_evolution::Input {
        history,
        temperatures: source.temperatures,
        moderator: source.moderator,
        water_rows: source.water,
        water_owners,
        external_water_volumes: Vec::new(),
        row_map,
        targets: source.amounts,
        passive_stocks: source.passive_stocks,
        passive_incidence: source.passive_incidence,
        cylinder_targets: source.cylinders,
        cylinder_incidence: source.cylinder_incidence,
        envelope_lengths: source.ell,
        faces: source.faces,
        optical_layers: source.optical_layers,
        mn,
    };
    Prepared {
        input,
        target_emissions: source.emissions,
        cf_decay_rate: cf.decay_rate,
        neutron_coordinates,
        segments: ns,
        water_owners: no,
        targets,
        mn_targets: nm,
    }
}

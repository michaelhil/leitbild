//! Strict six-frame cold source/cooling/barrel/pressure preparation. Primary chemistry is
//! replaced by actual carrier intersections, never cloned as source histories.
use super::{
    barrel_thermal, evolution_input, fuel_thermal, moderator_source, operating_network,
    operating_network_input, source_cooling, source_evolution, source_input, water_carrier,
};
use source_input::{count, framed, number};
use std::collections::BTreeSet;
mod pressure;

pub(crate) struct Prepared {
    pub model: source_cooling::Model,
    pub target_emissions: Vec<[f64; 2]>,
}

pub(crate) fn parse(text: &str) -> Result<Prepared, String> {
    let words = text.split_whitespace().collect::<Vec<_>>();
    let mut words = words.iter().copied();
    let source = framed(&mut words).join(" ");
    let network = framed(&mut words).join(" ");
    let thermal = framed(&mut words);
    let primary = framed(&mut words);
    let barrel = framed(&mut words);
    let pressure = framed(&mut words);
    if words.next().is_some() {
        return Err("Trailing coupled payload".into());
    }
    let mut prepared = evolution_input::parse(&source);
    let mut nw = network.split_whitespace();
    let network_input = operating_network_input::parse(&mut nw)?;
    if nw.next().is_some() || network_input.horizon != 300. {
        return Err("Expected complete 300 s network frame".into());
    }
    let network = operating_network::Network::new(network_input.config)?;
    let cells = network.config().water.len();
    let mut t = thermal.iter().copied();
    let nt = count(&mut t);
    let nb = count(&mut t);
    let nh = count(&mut t);
    let nfuel = count(&mut t);
    if nt > t.len() || nb > t.len() || nh > t.len() || nfuel > nt {
        return Err("Thermal counts exceed frame".into());
    }
    let mut bands = Vec::with_capacity(nb);
    for _ in 0..nb {
        let fuel_radius_m = number(&mut t);
        let clad_inner_radius_m = number(&mut t);
        let clad_outer_radius_m = number(&mut t);
        let length_m = number(&mut t);
        let rods = count(&mut t);
        let nf = count(&mut t);
        if nf > t.len() {
            return Err("Fuel masses exceed frame".into());
        }
        let fuel_masses_kg = (0..nf).map(|_| number(&mut t)).collect();
        let nc = count(&mut t);
        if nc > t.len() {
            return Err("Clad masses exceed frame".into());
        }
        let clad_masses_kg = (0..nc).map(|_| number(&mut t)).collect();
        bands.push(fuel_thermal::Band {
            fuel_radius_m,
            clad_inner_radius_m,
            clad_outer_radius_m,
            length_m,
            rods,
            fuel_masses_kg,
            clad_masses_kg,
            helium: count(&mut t),
            water: count(&mut t),
            flow_area_m2: number(&mut t),
            hydraulic_diameter_m: number(&mut t),
            fuel_emissivity: number(&mut t),
            clad_emissivity: number(&mut t),
        });
    }
    let helium = (0..nh)
        .map(|_| fuel_thermal::Helium {
            volume_m3: number(&mut t),
            nr_j_k: number(&mut t),
            accommodation: number(&mut t),
        })
        .collect();
    let thermal_model = fuel_thermal::Model::new(bands, helium, cells)?;
    if thermal_model.node_count() != nt || thermal_model.fuel_node_count() != nfuel {
        return Err("Compiled thermal layout differs from declared frame".into());
    }
    let initial_t = (0..nt).map(|_| number(&mut t)).collect();
    let fuel_rows = (0..nfuel).map(|_| count(&mut t)).collect();
    let water_flows = (0..cells)
        .map(|_| {
            let v = t
                .next()
                .expect("Missing water film edge")
                .parse::<i64>()
                .expect("Invalid water film edge");
            if v == -1 {
                None
            } else {
                assert!(v >= 0, "Unknown water film edge sentinel");
                Some(v as usize)
            }
        })
        .collect();
    if t.next().is_some() {
        return Err("Trailing thermal frame".into());
    }
    let mut p = primary.iter().copied();
    if count(&mut p) != cells {
        return Err("Primary carrier cell count differs".into());
    }
    let href = number(&mut p);
    let bref = number(&mut p);
    if !href.is_finite() || href <= 0. || !bref.is_finite() || bref < 0. {
        return Err("Invalid carrier reference counts per kg".into());
    }
    let nclosed = count(&mut p);
    if nclosed > prepared.input.water_owners.len() || nclosed > p.len() {
        return Err("Closed owner count exceeds source frame".into());
    }
    let closed = (0..nclosed).map(|_| count(&mut p)).collect::<Vec<_>>();
    if closed
        .iter()
        .any(|&o| o >= prepared.input.water_owners.len())
        || closed.iter().copied().collect::<BTreeSet<_>>().len() != closed.len()
    {
        return Err("Invalid explicit closed owner indices".into());
    }
    let mut owners = closed
        .iter()
        .map(|&o| prepared.input.water_owners[o])
        .collect::<Vec<_>>();
    let old_rows = prepared.input.moderator.intersections();
    let mut rows = Vec::new();
    let mut row_map = Vec::new();
    let mut stocks = Vec::new();
    for (i, r) in prepared.input.row_map.iter().enumerate() {
        if let Some(owner) = closed.iter().position(|&o| o == r.owner) {
            rows.push(old_rows[i]);
            stocks.push(prepared.input.water_rows[i]);
            row_map.push(source_evolution::WaterRow { owner, ..*r });
        }
    }
    let initial_network = network.initial_state()?;
    let mut work = operating_network::Workspace::new(&network);
    work.evaluate(
        &network,
        &initial_network,
        &vec![0.; network.dimension()],
        None,
    )?;
    let preparation = (0..cells)
        .map(|i| {
            let mass = work.chart_mass[i];
            owners.push(source_evolution::WaterOwner {
                authority: source_evolution::WaterAuthority::External { index: i },
                hydrogen: href * mass,
                hydrogen_product: 0.,
                boron: bref * mass,
                boron_product: 0.,
            });
            water_carrier::Preparation {
                mass,
                volume: network.config().water[i].geometry.volume,
                hydrogen_atoms: href * mass,
                boron_atoms: bref * mass,
            }
        })
        .collect::<Vec<_>>();
    let nr = count(&mut p);
    if nr > p.len() / 4 {
        return Err("External intersections exceed frame".into());
    }
    let mut unique = BTreeSet::new();
    for _ in 0..nr {
        let region = count(&mut p);
        let cell = count(&mut p);
        let volume = number(&mut p);
        let fraction = number(&mut p);
        if cell >= cells
            || region >= prepared.input.moderator.volumes().len()
            || !unique.insert((region, cell))
            || !volume.is_finite()
            || volume <= 0.
            || !fraction.is_finite()
            || fraction <= 0.
            || (fraction * preparation[cell].volume - volume).abs() > 3e-11 * volume
        {
            return Err("Invalid exact external water intersection".into());
        }
        rows.push(moderator_source::Intersection { region, volume });
        row_map.push(source_evolution::WaterRow {
            owner: nclosed + cell,
            h_fraction: 0.,
            b_fraction: 0.,
            volume_fraction: fraction,
        });
        stocks.push(moderator_source::Stocks {
            water_mass: preparation[cell].mass * fraction,
            liquid_volume: volume,
            hydrogen_target: preparation[cell].hydrogen_atoms * fraction,
            hydrogen_product: 0.,
            mobile_boron10: preparation[cell].boron_atoms * fraction,
        });
    }
    if p.next().is_some() {
        return Err("Trailing primary carrier frame".into());
    }
    prepared.input.moderator = moderator_source::ModeratorModel::new(
        prepared.input.moderator.law().clone(),
        prepared.input.moderator.volumes().to_vec(),
        rows,
    )?;
    prepared.input.water_owners = owners;
    prepared.input.row_map = row_map;
    prepared.input.water_rows = stocks;
    let carrier = water_carrier::Carrier::new(
        &preparation,
        network
            .config()
            .hydraulic
            .iter()
            .map(|e| water_carrier::Link {
                from: e.from,
                to: e.to,
            })
            .collect(),
    )?;
    let source = source_evolution::Evolution::new(prepared.input)?;
    let mut b = barrel.iter().copied();
    let mass_kg = number(&mut b);
    let cp_constant_j_kg_k = number(&mut b);
    let cp_linear_j_kg_k2 = number(&mut b);
    let datum_k = number(&mut b);
    let minimum_k = number(&mut b);
    let maximum_k = number(&mut b);
    let initial_temperature_k = number(&mut b);
    let steel_density_kg_m3 = number(&mut b);
    let host_chord_m = number(&mut b);
    let steel_mu_en_m2_kg = number(&mut b);
    let liquid_mu_en_m2_kg = number(&mut b);
    let wet_h_w_m2_k = number(&mut b);
    let mut targets = [0; 4];
    let mut capture_photon_j = [0.; 4];
    for i in 0..4 {
        targets[i] = count(&mut b);
        capture_photon_j[i] = number(&mut b);
    }
    let mn_owner = count(&mut b);
    let mn = source
        .mn_targets()
        .get(mn_owner)
        .ok_or("Missing barrel Mn owner")?;
    let nc = count(&mut b);
    if nc > b.len() / 3 {
        return Err("Barrel contacts exceed frame".into());
    }
    let contacts = (0..nc)
        .map(|_| barrel_thermal::Contact {
            water: count(&mut b),
            area_m2: number(&mut b),
            liquid_chord_m: number(&mut b),
        })
        .collect();
    if b.next().is_some() {
        return Err("Trailing barrel frame".into());
    }
    let barrel = barrel_thermal::Model::new(barrel_thermal::Input {
        mass_kg,
        cp_constant_j_kg_k,
        cp_linear_j_kg_k2,
        datum_k,
        minimum_k,
        maximum_k,
        initial_temperature_k,
        steel_density_kg_m3,
        host_chord_m,
        steel_mu_en_m2_kg,
        liquid_mu_en_m2_kg,
        wet_h_w_m2_k,
        targets,
        capture_photon_j,
        mn_owner,
        mn_electron_j: mn.electron_j,
        mn_photon_j: mn.photon_j,
        water_count: cells,
        contacts,
    })?;
    let pressure = pressure::parse(&pressure, &network, &initial_network, &work, href, bref)?;
    let model = source_cooling::Model::new(
        source,
        network,
        thermal_model,
        carrier,
        barrel,
        pressure,
        fuel_rows,
        water_flows,
        initial_t,
    )?;
    Ok(Prepared {
        model,
        target_emissions: prepared.target_emissions,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sixth_pressure_frame_is_required_and_extra_frames_refuse() {
        assert!(std::panic::catch_unwind(|| parse("0 0 0 0")).is_err());
        assert!(std::panic::catch_unwind(|| parse("0 0 0 0 0")).is_err());
        assert!(parse("0 0 0 0 0 0 0").is_err());
    }
}

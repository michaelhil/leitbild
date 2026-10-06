//! Strict numeric offline handoff from the current physical-owner compiler.
//! No property solve, thermal law, time integration or live Pack registration.
use leitbild_plant_numerics::primary_constraints::{
    Carrier, Edge, Network, mechanics, project_metric,
};
use std::io::{self, Read};

fn dot(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
fn relative_defect(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs()).max(1.)
}

// Dimensionless diagonal-scaled Cholesky is a structural rank screen only.
fn minimum_pivot(c: &[Vec<f64>]) -> Result<f64, String> {
    let n = c.len();
    if n == 0 {
        return Err("No circulating coordinates".into());
    }
    if c.iter()
        .enumerate()
        .any(|(i, row)| row.len() != n || !row[i].is_finite() || row[i] <= 0.)
    {
        return Err("Nonpositive circulation metric diagonal".into());
    }
    let mut l = vec![vec![0.; n]; n];
    let mut minimum = f64::INFINITY;
    for i in 0..n {
        for j in 0..=i {
            let mut x = c[i][j] / c[i][i].sqrt() / c[j][j].sqrt();
            for k in 0..j {
                x -= l[i][k] * l[j][k];
            }
            if i == j {
                if !x.is_finite() || x <= 1e-12 {
                    return Err("Unspanned or singular circulation metric".into());
                }
                minimum = minimum.min(x);
                l[i][j] = x.sqrt();
            } else {
                l[i][j] = x / l[j][j];
            }
        }
    }
    Ok(minimum)
}

fn main() -> Result<(), String> {
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let mut tokens = text.split_whitespace();
    let mut next = || {
        tokens
            .next()
            .ok_or_else(|| "Missing primary constraint input".to_string())
    };
    let nodes = next()?.parse::<usize>().map_err(|e| e.to_string())?;
    let edge_count = next()?.parse::<usize>().map_err(|e| e.to_string())?;
    let carrier_count = next()?.parse::<usize>().map_err(|e| e.to_string())?;
    let unmapped_supports = next()?.parse::<usize>().map_err(|e| e.to_string())?;
    let root = next()?.parse::<usize>().map_err(|e| e.to_string())?;
    let mut edges = Vec::new();
    for _ in 0..edge_count {
        edges.push(Edge {
            from: next()?.parse::<usize>().map_err(|e| e.to_string())?,
            to: next()?.parse::<usize>().map_err(|e| e.to_string())?,
        });
    }
    let graph = Network::new(nodes, &edges, root)?;
    let mut snapshots = Vec::new();
    for _ in 0..carrier_count {
        let owner = next()?.to_string();
        let mass = next()?.parse::<f64>().map_err(|e| e.to_string())?;
        let mass_rate = next()?.parse::<f64>().map_err(|e| e.to_string())?;
        let mut map = Vec::new();
        let mut map_rate = Vec::new();
        for _ in 0..edge_count {
            map.push(next()?.parse::<f64>().map_err(|e| e.to_string())?);
        }
        for _ in 0..edge_count {
            map_rate.push(next()?.parse::<f64>().map_err(|e| e.to_string())?);
        }
        snapshots.push((owner, mass, mass_rate, map, map_rate));
    }
    let mut vector = |length: usize| -> Result<Vec<f64>, String> {
        (0..length)
            .map(|_| next()?.parse::<f64>().map_err(|e| e.to_string()))
            .collect()
    };
    let rates = vector(nodes)?;
    let amplitudes = vector(graph.cycle_count())?;
    let flow_rate = vector(edge_count)?;
    let pressures = vector(nodes)?;
    let donor_density = vector(edge_count)?;
    if tokens.next().is_some() {
        return Err("Trailing primary constraint input".into());
    }
    let flow = graph.reconstruct(&amplitudes, &rates)?;
    let actual_rates = graph.divergence(&flow)?;
    let mass_defect = rates
        .iter()
        .zip(&actual_rates)
        .map(|(a, b)| relative_defect(*a, *b))
        .fold(0., f64::max);
    let tree = graph.tree_basis()?;
    let mut cycle_defect: f64 = 0.;
    for j in 0..graph.cycle_count() {
        let column: Vec<_> = graph.cycles().iter().map(|row| row[j]).collect();
        for x in graph.divergence(&column)? {
            cycle_defect = cycle_defect.max(x.abs());
        }
    }
    let carriers: Vec<_> = snapshots
        .iter()
        .map(|(owner, mass, mass_rate, map, map_rate)| Carrier {
            owner,
            mass: *mass,
            mass_rate: *mass_rate,
            velocity_map: map,
            velocity_map_rate: map_rate,
        })
        .collect();
    let m = mechanics(&flow, &flow_rate, &carriers)?;
    let ss = project_metric(&m.metric, graph.cycles(), graph.cycles())?;
    let st = project_metric(&m.metric, graph.cycles(), &tree)?;
    let tt = project_metric(&m.metric, &tree, &tree)?;
    let pivot = minimum_pivot(&ss)?;
    let (pressure_resistance, volume_divergence) =
        graph.pressure_work(&pressures, &donor_density, &flow)?;
    let power = dot(&flow, &pressure_resistance);
    let dual_power = dot(&pressures, &volume_divergence);
    let work_defect = relative_defect(power, dual_power);
    let kinetic_defect = relative_defect(m.kinetic_rate, m.conjugate_identity_rate);
    // Declared structural arithmetic screens, not physics/entropy tolerance.
    if [mass_defect, cycle_defect, work_defect, kinetic_defect]
        .iter()
        .any(|x| !x.is_finite() || *x > 1e-10)
    {
        return Err("Primary structural arithmetic gate failed".into());
    }
    let nonzero_cross = st.iter().flatten().filter(|x| x.abs() > 0.).count();
    let metrics_finite = ss
        .iter()
        .chain(&st)
        .chain(&tt)
        .flatten()
        .all(|x| x.is_finite());
    if !metrics_finite {
        return Err("Nonfinite projected mechanics".into());
    }
    println!(
        "{{\"scope\":\"connected-incidence-and-snapshot-mechanical-algebra\",\"structuralAdmitted\":true,\"physicalManifoldAdmitted\":false,\"metricCoverageComplete\":{},\"unmappedSupports\":{},\"nodes\":{},\"edges\":{},\"incidenceRank\":{},\"cycles\":{},\"massRateRelativeDefect\":{:.17e},\"cycleDefect\":{:.17e},\"kineticDerivativeRelativeDefect\":{:.17e},\"pressureWorkRelativeDefect\":{:.17e},\"pressureResistancePower_W\":{:.17e},\"kineticEnergy_J\":{:.17e},\"minimumScaledCirculationPivot\":{:.17e},\"nonzeroCycleTreeCrossTerms\":{},\"obligations\":[\"derived-thermal-and-PZR-rate-map\",\"finite-junction-and-mixed-support-momentum\",\"hydrostatic-and-changing-elevation-work\",\"reciprocal-low-Mach-pressure-and-thermal-conjugates\",\"entropy-uncertainty-and-index-reduction\",\"connected-operating-advancement\"]}}",
        unmapped_supports == 0,
        unmapped_supports,
        nodes,
        edge_count,
        graph.rank(),
        graph.cycle_count(),
        mass_defect,
        cycle_defect,
        kinetic_defect,
        work_defect,
        power,
        m.kinetic_energy,
        pivot,
        nonzero_cross
    );
    Ok(())
}

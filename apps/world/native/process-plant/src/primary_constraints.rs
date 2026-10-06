//! Offline connected-primary constraint algebra, not an advancing fluid model.
//! B acts on MASS flow. Velocity maps and their rates come from an identified
//! physical snapshot; this module does not infer EOS/thermal/PZR compatibility.

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
}

#[derive(Debug)]
pub struct Network {
    nodes: usize,
    edges: Vec<Edge>,
    root: usize,
    // Root first, descendants after parents. Each nonroot has one tree edge.
    order: Vec<usize>,
    parent: Vec<Option<(usize, usize)>>,
    /// Edge rows, chord columns; B*S=0. No prescribed plant cycle count.
    cycles: Vec<Vec<f64>>,
}

fn finite(values: &[f64]) -> Result<(), &'static str> {
    if values.iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err("Nonfinite primary algebra input")
    }
}

impl Network {
    pub fn new(nodes: usize, edges: &[Edge], root: usize) -> Result<Self, &'static str> {
        if nodes < 2
            || root >= nodes
            || edges
                .iter()
                .any(|e| e.from >= nodes || e.to >= nodes || e.from == e.to)
        {
            return Err("Invalid primary incidence");
        }
        let mut adjacent = vec![Vec::new(); nodes];
        for (i, e) in edges.iter().enumerate() {
            adjacent[e.from].push((e.to, i));
            adjacent[e.to].push((e.from, i));
        }
        let mut order = vec![root];
        let mut seen = vec![false; nodes];
        seen[root] = true;
        let mut parent = vec![None; nodes];
        let mut tree = vec![false; edges.len()];
        let mut cursor = 0;
        while cursor < order.len() {
            for &(next, edge) in &adjacent[order[cursor]] {
                if !seen[next] {
                    seen[next] = true;
                    tree[edge] = true;
                    parent[next] = Some((order[cursor], edge));
                    order.push(next);
                }
            }
            cursor += 1;
        }
        if order.len() != nodes {
            return Err("Disconnected primary inventory");
        }
        let chords: Vec<_> = (0..edges.len()).filter(|&i| !tree[i]).collect();
        let mut graph = Self {
            nodes,
            edges: edges.to_vec(),
            root,
            order,
            parent,
            cycles: vec![vec![0.; chords.len()]; edges.len()],
        };
        for (column, &chord) in chords.iter().enumerate() {
            let mut b = vec![0.; nodes];
            b[edges[chord].from] = 1.;
            b[edges[chord].to] = -1.;
            let mut flow = graph.tree_lift(&b)?;
            flow[chord] += 1.;
            for (row, x) in flow.into_iter().enumerate() {
                graph.cycles[row][column] = x;
            }
        }
        Ok(graph)
    }

    pub fn rank(&self) -> usize {
        self.nodes - 1
    }
    pub fn cycle_count(&self) -> usize {
        self.edges.len() - self.rank()
    }
    pub fn node_count(&self) -> usize {
        self.nodes
    }
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }
    pub fn cycles(&self) -> &[Vec<f64>] {
        &self.cycles
    }

    pub fn divergence(&self, flow: &[f64]) -> Result<Vec<f64>, &'static str> {
        if flow.len() != self.edges.len() {
            return Err("Primary flow length mismatch");
        }
        finite(flow)?;
        let mut b = vec![0.; self.nodes];
        for (e, &q) in self.edges.iter().zip(flow) {
            b[e.from] -= q;
            b[e.to] += q;
        }
        finite(&b)?;
        Ok(b)
    }

    /// Unique tree redistribution for ALL supplied node mass rates. The root
    /// rate is checked, never silently replaced by an implied balancing source.
    pub fn tree_lift(&self, rates: &[f64]) -> Result<Vec<f64>, &'static str> {
        if rates.len() != self.nodes {
            return Err("Primary mass-rate length mismatch");
        }
        finite(rates)?;
        let sum: f64 = rates.iter().sum();
        let scale = rates.iter().map(|x| x.abs()).sum::<f64>().max(1.);
        finite(&[sum, scale])?;
        if sum.abs() > 1e-12 * scale {
            return Err("Unbalanced closed-primary mass rates");
        }
        let mut subtree = rates.to_vec();
        let mut flow = vec![0.; self.edges.len()];
        for &child in self.order.iter().rev().filter(|&&n| n != self.root) {
            let (parent, edge) = self.parent[child].ok_or("Missing primary tree parent")?;
            flow[edge] = if self.edges[edge].to == child {
                subtree[child]
            } else {
                -subtree[child]
            };
            subtree[parent] += subtree[child];
            finite(&[subtree[parent]])?;
        }
        finite(&flow)?;
        Ok(flow)
    }

    pub fn reconstruct(&self, amplitudes: &[f64], rates: &[f64]) -> Result<Vec<f64>, &'static str> {
        if amplitudes.len() != self.cycle_count() {
            return Err("Primary cycle length mismatch");
        }
        finite(amplitudes)?;
        let mut flow = self.tree_lift(rates)?;
        for (row, q) in self.cycles.iter().zip(&mut flow) {
            *q += row.iter().zip(amplitudes).map(|(s, a)| s * a).sum::<f64>();
        }
        finite(&flow)?;
        Ok(flow)
    }

    /// Gauge columns T: full node rates e_i-e_root, B*T=e_i-e_root.
    pub fn tree_basis(&self) -> Result<Vec<Vec<f64>>, &'static str> {
        let mut rows = vec![vec![0.; self.rank()]; self.edges.len()];
        for (j, n) in (0..self.nodes).filter(|&n| n != self.root).enumerate() {
            let mut b = vec![0.; self.nodes];
            b[n] = 1.;
            b[self.root] = -1.;
            for (row, q) in self.tree_lift(&b)?.into_iter().enumerate() {
                rows[row][j] = q;
            }
        }
        Ok(rows)
    }

    /// Incidence dual for a SPECIFIC mass multiplier (J/kg), not pressure Pa.
    pub fn mass_multiplier_force(&self, specific: &[f64]) -> Result<Vec<f64>, &'static str> {
        if specific.len() != self.nodes {
            return Err("Primary multiplier length mismatch");
        }
        finite(specific)?;
        let force: Vec<_> = self
            .edges
            .iter()
            .map(|e| specific[e.to] - specific[e.from])
            .collect();
        finite(&force)?;
        Ok(force)
    }

    /// Actual pressure-work dual has a separate face donor density. Returns
    /// resistance-sign pressure drop per mass flow and node VOLUME divergence.
    /// Neither this identity nor B*f=0 makes pressure power vanish when donors differ.
    pub fn pressure_work(
        &self,
        pressure: &[f64],
        donor_density: &[f64],
        flow: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), &'static str> {
        if donor_density.len() != self.edges.len()
            || donor_density.iter().any(|x| !x.is_finite() || *x <= 0.)
        {
            return Err("Invalid primary face donor densities");
        }
        let mut force = self.mass_multiplier_force(pressure)?;
        if flow.len() != self.edges.len() {
            return Err("Primary flow length mismatch");
        }
        finite(flow)?;
        let volume: Vec<_> = flow
            .iter()
            .zip(donor_density)
            .map(|(q, rho)| q / rho)
            .collect();
        for (f, rho) in force.iter_mut().zip(donor_density) {
            *f /= rho;
        }
        finite(&force)?;
        Ok((force, self.divergence(&volume)?))
    }
}

/// Every physical carrier occurs once; coefficients map edge MASS flow to its
/// mean velocity. Rates include changing donor density/area only if actually
/// supplied by the parent; a zero here does NOT select a constant-density plant.
pub struct Carrier<'a> {
    pub owner: &'a str,
    pub mass: f64,
    pub mass_rate: f64,
    pub velocity_map: &'a [f64],
    pub velocity_map_rate: &'a [f64],
}

pub struct Mechanics {
    pub metric: Vec<Vec<f64>>,
    pub metric_rate: Vec<Vec<f64>>,
    /// Energy-conjugate mass-flow momentum in J*s/kg, not kg*m/s.
    pub conjugate_flow_momentum: Vec<f64>,
    pub conjugate_flow_momentum_rate: Vec<f64>,
    pub kinetic_energy: f64,
    pub kinetic_rate: f64,
    pub conjugate_identity_rate: f64,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn mechanics(
    flow: &[f64],
    flow_rate: &[f64],
    carriers: &[Carrier<'_>],
) -> Result<Mechanics, &'static str> {
    let n = flow.len();
    if n == 0 || flow_rate.len() != n || carriers.is_empty() {
        return Err("Empty or mismatched primary mechanics");
    }
    finite(flow)?;
    finite(flow_rate)?;
    let mut owners = std::collections::HashSet::new();
    let mut c = vec![vec![0.; n]; n];
    let mut cdot = c.clone();
    let mut energy = 0.;
    let mut rate = 0.;
    for carrier in carriers {
        if carrier.owner.is_empty() || !owners.insert(carrier.owner) {
            return Err("Duplicate or empty primary carrier owner");
        }
        if !carrier.mass.is_finite()
            || carrier.mass <= 0.
            || !carrier.mass_rate.is_finite()
            || carrier.velocity_map.len() != n
            || carrier.velocity_map_rate.len() != n
        {
            return Err("Invalid primary carrier snapshot");
        }
        finite(carrier.velocity_map)?;
        finite(carrier.velocity_map_rate)?;
        if carrier.velocity_map.iter().all(|&x| x == 0.) {
            return Err("Unmapped moving primary carrier");
        }
        let r = carrier.velocity_map;
        let rd = carrier.velocity_map_rate;
        let v = dot(r, flow);
        let vd = dot(r, flow_rate) + dot(rd, flow);
        energy += 0.5 * carrier.mass * v * v;
        rate += 0.5 * carrier.mass_rate * v * v + carrier.mass * v * vd;
        for i in 0..n {
            for j in 0..n {
                c[i][j] += carrier.mass * r[i] * r[j];
                cdot[i][j] +=
                    carrier.mass_rate * r[i] * r[j] + carrier.mass * (rd[i] * r[j] + r[i] * rd[j]);
            }
        }
    }
    let momentum: Vec<_> = c.iter().map(|row| dot(row, flow)).collect();
    let momentum_rate: Vec<_> = c
        .iter()
        .zip(&cdot)
        .map(|(row, derivative)| dot(row, flow_rate) + dot(derivative, flow))
        .collect();
    let identity = dot(flow, &momentum_rate)
        - 0.5
            * flow
                .iter()
                .zip(&cdot)
                .map(|(q, row)| q * dot(row, flow))
                .sum::<f64>();
    for row in c.iter().chain(&cdot) {
        finite(row)?;
    }
    finite(&momentum)?;
    finite(&momentum_rate)?;
    finite(&[energy, rate, identity])?;
    Ok(Mechanics {
        metric: c,
        metric_rate: cdot,
        conjugate_flow_momentum: momentum,
        conjugate_flow_momentum_rate: momentum_rate,
        kinetic_energy: energy,
        kinetic_rate: rate,
        conjugate_identity_rate: identity,
    })
}

/// Leftᵀ C Right: circulation, redistribution and their nonzero crossblocks.
pub fn project_metric(
    c: &[Vec<f64>],
    left: &[Vec<f64>],
    right: &[Vec<f64>],
) -> Result<Vec<Vec<f64>>, &'static str> {
    let n = c.len();
    if n == 0 || c.iter().any(|r| r.len() != n) || left.len() != n || right.len() != n {
        return Err("Primary projection row mismatch");
    }
    let l = left[0].len();
    let r = right[0].len();
    if left.iter().any(|x| x.len() != l) || right.iter().any(|x| x.len() != r) {
        return Err("Primary projection column mismatch");
    }
    for row in c.iter().chain(left).chain(right) {
        finite(row)?;
    }
    let mut cr = vec![vec![0.; r]; n];
    for a in 0..n {
        for b in 0..n {
            for j in 0..r {
                cr[a][j] += c[a][b] * right[b][j];
            }
        }
    }
    let mut result = vec![vec![0.; r]; l];
    for i in 0..l {
        for j in 0..r {
            for a in 0..n {
                result[i][j] += left[a][i] * cr[a][j];
            }
        }
    }
    for row in &result {
        finite(row)?;
    }
    Ok(result)
}

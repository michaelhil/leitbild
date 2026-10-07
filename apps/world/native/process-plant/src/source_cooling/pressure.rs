//! Actual pressure-support incidence, phase-carried material and small fluid
//! stage matrices. Component laws stay with their own native owners.
use super::*;

/// Fresh finite pressure-support stocks. This is not a checkpoint migration
/// or an imposed pressure reservoir; subsequent trials own every stock.
pub struct PressureConnection {
    pub pressurizer: cp::Model,
    pub surge: fs::Model,
    pub primary_cell: usize,
    pub atoms_per_marker: f64,
    pub initial_pressurizer: [f64; cp::STATES],
    pub initial_surge: [f64; fs::STATES],
    pub initial_pool: wc::Amounts,
    pub initial_line: wc::Amounts,
    pub initial_gas_hydrogen_product: f64,
}

/// One fixed-upwind packet and tangent. Never switch donor on direction sign.
fn packet(q: f64, dq: f64, a: [f64; 3], da: [f64; 3], m: f64, dm: f64) -> ([f64; 3], [f64; 3]) {
    (
        a.map(|x| q * (x / m)),
        std::array::from_fn(|k| dq * (a[k] / m) + q * (da[k] / m - (a[k] / m) * (dm / m))),
    )
}

impl Model {
    pub(super) fn current_pressure_ports(
        &self,
        yn: &[f64],
        liquid: crate::Liquid,
        pool_y: &[f64; cp::STATES],
    ) -> Result<([fs::Port; 2], cp::PortResponse), String> {
        let cell = self.pressure_connection.primary_cell;
        let mechanical = self.network.mechanical_pressure(cell, yn);
        let pool = self.pressure_connection.pressurizer.port(pool_y)?;
        Ok((
            [
                fs::Port {
                    pressure: mechanical,
                    total_enthalpy: liquid.internal_energy
                        + mechanical / liquid.density
                        + crate::GRAVITY * self.network.config().water[cell].geometry.elevation,
                    elevation: self.network.config().water[cell].geometry.elevation,
                    density: liquid.density,
                    temperature: liquid.temperature,
                    entropy: liquid.entropy,
                    eos_pressure: liquid.pressure,
                },
                pool.port,
            ],
            pool,
        ))
    }
    /// Chart-only current-trial preparation for nonlinear physical closure.
    /// The caller owns separate small component workspaces and a successfully
    /// prepared matching network chart; no source/thermal evaluation occurs.
    pub fn pressure_chart_corrections(
        &self,
        nw: &on::Workspace,
        y: &[f64],
        yp: &[f64],
        pool: &mut cp::Workspace,
        line: &mut fs::Workspace,
    ) -> Result<([f64; 7], [f64; 2]), String> {
        if y.len() != self.dimension() || yp.len() != self.dimension() {
            return Err("Pressure chart state shape".into());
        }
        let l = self.layout;
        let yn = &y[l.network_start..l.carrier_start];
        nw.check_current_chart(&self.network, yn)?;
        let (ports, _) = self.current_pressure_ports(
            yn,
            nw.liquids[self.pressure_connection.primary_cell],
            array(&y[l.pressurizer_start..l.surge_start]),
        )?;
        let p = &self.pressure_connection;
        p.surge.evaluate(
            array(&y[l.surge_start..l.surge_carrier_start]),
            array(&yp[l.surge_start..l.surge_carrier_start]),
            &ports,
            Some(0.),
            line,
        )?;
        let receipt = line.receipts()?;
        p.pressurizer.evaluate(
            array(&y[l.pressurizer_start..l.surge_start]),
            array(&yp[l.pressurizer_start..l.surge_start]),
            cp::Balance {
                mass: -receipt.mass[1],
                energy: -receipt.energy[1],
            },
            Some(0.),
            pool,
        )?;
        let correction = p
            .pressurizer
            .chart_corrections(pool, array(&y[l.pressurizer_start..l.surge_start]))?;
        let j = line.jacobian()?;
        let f = line.residual()?;
        let a = j[fs::PRESSURE][fs::PRESSURE];
        let b = j[fs::PRESSURE][fs::TEMPERATURE];
        let c = j[fs::TEMPERATURE][fs::PRESSURE];
        let d = j[fs::TEMPERATURE][fs::TEMPERATURE];
        let determinant = a * d - b * c;
        let line_correction = [
            (-f[fs::PRESSURE] * d + b * f[fs::TEMPERATURE]) / determinant,
            (-a * f[fs::TEMPERATURE] + c * f[fs::PRESSURE]) / determinant,
        ];
        if !determinant.is_finite()
            || determinant == 0.
            || line_correction.iter().any(|v| !v.is_finite())
        {
            return Err("Singular/nonfinite surge chart correction".into());
        }
        Ok((correction, line_correction))
    }
    /// Actual phase-carried chemistry: two liquid faces, an independently
    /// signed interface transfer and gross wall condensate return. Air mass
    /// never dilutes the gas water product, and no boron evaporates.
    pub(super) fn pressure_material(
        &self,
        y: &[f64],
        dy: Option<&[f64]>,
        mass: f64,
        dmass: f64,
        phase: cp::Diagnostics,
        dphase: Option<&[f64; 16]>,
        flows: [f64; 2],
    ) -> Result<([f64; 10], [f64; 10]), String> {
        self.pressure_material_by(
            y,
            |r| dy.map_or(0., |d| d[r]),
            mass,
            dmass,
            phase,
            dphase,
            flows,
            [0.; 2],
        )
    }
    fn pressure_material_by(
        &self,
        y: &[f64],
        at: impl Fn(usize) -> f64,
        mass: f64,
        dmass: f64,
        phase: cp::Diagnostics,
        dphase: Option<&[f64; 16]>,
        flows: [f64; 2],
        dflows: [f64; 2],
    ) -> Result<([f64; 10], [f64; 10]), String> {
        let l = self.layout;
        let get = |r| std::array::from_fn(|k| y[r + k]);
        let dget = |r| std::array::from_fn(|k| at(r + k));
        let primary = l.carrier_start + wc::WIDTH * self.pressure_connection.primary_cell;
        let states = [
            get(primary),
            get(l.surge_carrier_start),
            get(l.pool_carrier_start),
        ];
        let ds = [
            dget(primary),
            dget(l.surge_carrier_start),
            dget(l.pool_carrier_start),
        ];
        let masses = [
            mass,
            y[l.surge_start + fs::MASS],
            y[l.pressurizer_start + cp::LIQUID_MASS],
        ];
        let dms = [
            dmass,
            at(l.surge_start + fs::MASS),
            at(l.pressurizer_start + cp::LIQUID_MASS),
        ];
        if masses.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err("Invalid pressure-connection material donor".into());
        }
        let mut rates = [0.; 10];
        let mut tangent = [0.; 10];
        for (a, b, end) in [(0, 1, 0), (1, 2, 1)] {
            let q = flows[end];
            let d = if q >= 0. { a } else { b };
            let (v, dv) = packet(q, dflows[end], states[d], ds[d], masses[d], dms[d]);
            for k in 0..3 {
                rates[3 * a + k] -= v[k];
                rates[3 * b + k] += v[k];
                tangent[3 * a + k] -= dv[k];
                tangent[3 * b + k] += dv[k];
            }
        }
        let gamma = phase.evaporation;
        let dg = dphase.map_or(0., |p| p[cp::DIAGNOSTIC_EVAPORATION]);
        let c = phase.wall_condensation;
        let dc = dphase.map_or(0., |p| p[cp::DIAGNOSTIC_WALL_CONDENSATION]);
        let gas_mass = y[l.pressurizer_start + cp::VAPOR_MASS];
        let dgas_mass = at(l.pressurizer_start + cp::VAPOR_MASS);
        let gas = y[l.gas_hydrogen_product];
        let dgas = at(l.gas_hydrogen_product);
        if !gas_mass.is_finite() || gas_mass <= 0. {
            return Err("Invalid pressure-connection vapor donor".into());
        }
        let (v, dv) = if gamma >= 0. {
            packet(gamma, dg, states[2], ds[2], masses[2], dms[2])
        } else {
            packet(
                gamma,
                dg,
                [gas, 0., 0.],
                [dgas, 0., 0.],
                gas_mass,
                dgas_mass,
            )
        };
        rates[6] -= v[0];
        rates[9] += v[0];
        tangent[6] -= dv[0];
        tangent[9] += dv[0];
        let (v, dv) = packet(c, dc, [gas, 0., 0.], [dgas, 0., 0.], gas_mass, dgas_mass);
        rates[6] += v[0];
        rates[9] -= v[0];
        tangent[6] += dv[0];
        tangent[9] -= dv[0];
        if rates.iter().chain(&tangent).any(|v| !v.is_finite()) {
            return Err("Nonfinite pressure-connection material transaction".into());
        }
        Ok((rates, tangent))
    }
    /// Only prepared local pressure/phase/material response; no EOS or full
    /// source/thermal evaluation is performed during a Krylov action.
    pub(super) fn pressure_tangent(
        &self,
        dy: &[f64],
        cj: f64,
        w: &Workspace,
    ) -> Result<
        (
            [f64; cp::STATES],
            [f64; fs::STATES],
            fs::Receipts,
            [f64; 16],
            [f64; 10],
        ),
        String,
    > {
        self.pressure_tangent_by(|r| dy[r], cj, w)
    }
    fn pressure_tangent_by(
        &self,
        at: impl Fn(usize) -> f64,
        cj: f64,
        w: &Workspace,
    ) -> Result<
        (
            [f64; cp::STATES],
            [f64; fs::STATES],
            fs::Receipts,
            [f64; 16],
            [f64; 10],
        ),
        String,
    > {
        let l = self.layout;
        let p = &self.pressure_connection;
        let n = &self.network;
        let cell = p.primary_cell;
        let dp = at(l.network_start + n.pressure_row());
        let dt = at(l.network_start + n.temperature_row(cell));
        let pi = n.relative_pressure(cell, &w.state[l.network_start..l.carrier_start]);
        let dpi = n
            .mechanical_row(cell)
            .map_or(0., |r| at(l.network_start + r));
        let liquid = w.hot_liquid;
        let mut ports = [fs::PortDirection::default(); 2];
        ports[0] = fs::PortDirection {
            pressure: dp + dpi,
            total_enthalpy: (1.
                - liquid.temperature * liquid.expansion
                - pi * liquid.compressibility)
                / liquid.density
                * dp
                + (liquid.cp + pi * liquid.expansion / liquid.density) * dt
                + dpi / liquid.density,
            density: liquid.density * (liquid.compressibility * dp - liquid.expansion * dt),
        };
        let dcp = std::array::from_fn::<_, { cp::STATES }, _>(|r| at(l.pressurizer_start + r));
        for (partial, &v) in w
            .pool_port
            .as_ref()
            .ok_or("Missing current PZR port")?
            .partials
            .iter()
            .zip(&dcp)
        {
            ports[1].pressure += partial.pressure * v;
            ports[1].total_enthalpy += partial.total_enthalpy * v;
            ports[1].density += partial.density * v;
        }
        let (line, receipts) = p.surge.jvp(
            &w.surge,
            &std::array::from_fn(|r| at(l.surge_start + r)),
            &ports,
            cj,
        )?;
        let pool = p.pressurizer.jvp(
            &w.pressurizer,
            &dcp,
            cp::Balance {
                mass: -receipts.mass[1],
                energy: -receipts.energy[1],
            },
            cj,
        )?;
        let phase = p.pressurizer.diagnostic_jvp(&w.pressurizer, &dcp)?;
        let d = w.network.chart_derivatives[cell];
        let (_, material) = self.pressure_material_by(
            &w.state,
            &at,
            w.mass[cell],
            d[0] * dp + d[1] * dt,
            w.pressurizer.diagnostics()?,
            Some(&phase),
            [w.surge.receipts()?.mass[0], -w.surge.receipts()?.mass[1]],
            [receipts.mass[0], -receipts.mass[1]],
        )?;
        Ok((pool, line, receipts, phase, material))
    }
    /// Thermodynamic forward-chart residual rows. Mechanical continuity and
    /// hydraulic force rows are deliberately absent: differentiating those
    /// requires accelerations, not just the initial coordinate rates.
    pub fn forward_chart_rows(&self) -> Vec<usize> {
        let l = self.layout;
        let n = &self.network;
        std::iter::once(l.network_start + n.pressure_row())
            .chain((0..n.config().water.len()).map(|i| l.network_start + n.temperature_row(i)))
            .chain((0..n.config().secondaries.len()).flat_map(|i| {
                [
                    l.network_start + n.secondary_temperature_row(i),
                    l.network_start + n.secondary_pressure_row(i),
                ]
            }))
            .chain((cp::LIQUID_TEMPERATURE..=cp::LIQUID_PRESSURE).map(|r| l.pressurizer_start + r))
            .chain((0..cp::METALS).map(|i| l.pressurizer_start + cp::METAL_TEMPERATURE_START + i))
            .chain([
                l.surge_start + fs::PRESSURE,
                l.surge_start + fs::TEMPERATURE,
                l.surge_start + fs::STEEL_TEMPERATURE,
            ])
            .collect()
    }
    /// Exact physical F_yp of the coupled fluid border, including the primary
    /// reduced continuity and reciprocal phase-volume work. This is NOT the
    /// identity matrix on differential rows. Use a Some(0) preparation for
    /// the companion F_y matrix; do not recover it by large-cj subtraction.
    pub fn visit_fluid_rate_matrix(
        &self,
        w: &Workspace,
        mut emit: impl FnMut(usize, usize, f64),
    ) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &w.owner) || !w.valid || w.jacobian_cj.is_none() {
            return Err("Fluid rate matrix requires owned current linearization".into());
        }
        let l = self.layout;
        let n = &self.network;
        for r in 0..n.dimension() {
            if n.is_differential(r) {
                emit(l.network_start + r, l.network_start + r, 1.);
            }
        }
        let sum_a: f64 = w.network.redistribution.iter().map(|a| a[0]).sum();
        if !sum_a.is_finite() || sum_a <= 0. {
            return Err("Singular fluid pressure-rate chart".into());
        }
        for i in 1..n.config().water.len() {
            let r = l.network_start + n.mechanical_row(i).unwrap();
            let [a, b] = w.network.redistribution[i];
            emit(r, l.network_start + n.total_mass_row(), a / sum_a);
            for j in 0..n.config().water.len() {
                emit(
                    r,
                    l.network_start + n.energy_row(j),
                    if i == j { b } else { 0. } - a * w.network.redistribution[j][1] / sum_a,
                );
            }
        }
        for r in l.carrier_start..l.energies_start {
            emit(r, r, 1.);
        }
        for (r, row) in w.pressurizer.rate_matrix()?.iter().enumerate() {
            for (c, &v) in row.iter().enumerate() {
                emit(l.pressurizer_start + r, l.pressurizer_start + c, v);
            }
        }
        for r in [
            fs::MASS,
            fs::ENERGY,
            fs::LEFT_MOMENTUM,
            fs::RIGHT_MOMENTUM,
            fs::STEEL_ENERGY,
        ] {
            emit(l.surge_start + r, l.surge_start + r, 1.);
        }
        for r in l.surge_carrier_start..l.dimension {
            emit(r, r, 1.);
        }
        Ok(())
    }
    /// Small coupled fluid/material stage matrix. Captures and solid heat
    /// forcing are held at this current trial: this is a preconditioner/IC
    /// inexact-Newton matrix, not a substitute for the complete outer JVP.
    /// Duplicate emitted slots are additive; structural zero slots are kept.
    pub fn visit_fluid_jacobian(
        &self,
        w: &Workspace,
        mut emit: impl FnMut(usize, usize, f64),
    ) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &w.owner) || !w.valid {
            return Err("Fluid matrix requires owned current stage".into());
        }
        let cj = w
            .jacobian_cj
            .ok_or("Fluid matrix requires current linearization")?;
        let l = self.layout;
        let n = &self.network;
        for col in 0..n.dimension() {
            for slot in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                emit(
                    l.network_start + n.row_indices[slot] as usize,
                    l.network_start + col,
                    w.network.jacobian_values[slot],
                );
            }
        }
        for cell in 0..self.carrier.cells() {
            for k in 0..wc::WIDTH {
                let r = l.carrier_start + wc::WIDTH * cell + k;
                emit(r, r, cj);
            }
        }
        for (edge, link) in self.carrier.links().iter().enumerate() {
            let q = w.network.mass_flows[edge];
            let donor = if q >= 0. { link.from } else { link.to };
            let m = w.mass[donor];
            for k in 0..wc::WIDTH {
                let amount = w.products[donor].values()[k];
                let from = l.carrier_start + wc::WIDTH * link.from + k;
                let to = l.carrier_start + wc::WIDTH * link.to + k;
                let columns = [
                    from,
                    to,
                    l.network_start + n.pressure_row(),
                    l.network_start + n.temperature_row(link.from),
                    l.network_start + n.temperature_row(link.to),
                    l.network_start + n.flow_row(edge),
                ];
                for col in columns {
                    let da = if col == l.carrier_start + wc::WIDTH * donor + k {
                        1.
                    } else {
                        0.
                    };
                    let dm = if col == l.network_start + n.pressure_row() {
                        w.network.chart_derivatives[donor][0]
                    } else if col == l.network_start + n.temperature_row(donor) {
                        w.network.chart_derivatives[donor][1]
                    } else {
                        0.
                    };
                    let dq = if col == l.network_start + n.flow_row(edge) {
                        1.
                    } else {
                        0.
                    };
                    let value = dq * amount / m + q * (da / m - (amount / m) * (dm / m));
                    emit(from, col, value);
                    emit(to, col, -value);
                }
            }
        }
        let cell = self.pressure_connection.primary_cell;
        let primary = l.carrier_start + wc::WIDTH * cell;
        let columns = (l.pressurizer_start..l.gas_hydrogen_product + 1)
            .chain([
                l.network_start + n.pressure_row(),
                l.network_start + n.temperature_row(cell),
            ])
            .chain(n.mechanical_row(cell).map(|r| l.network_start + r))
            .chain(primary..primary + wc::WIDTH);
        // Only the fixed small pressure-support incidence is contracted here;
        // no whole-state direction vector, EOS call or source JVP is formed.
        for col in columns {
            let (pool, line, receipt, phase, material) =
                self.pressure_tangent_by(|r| if r == col { 1. } else { 0. }, cj, w)?;
            for (r, &v) in pool.iter().enumerate() {
                emit(l.pressurizer_start + r, col, v);
            }
            for (r, &v) in line.iter().enumerate() {
                emit(l.surge_start + r, col, v);
            }
            emit(l.network_start + n.total_mass_row(), col, receipt.mass[0]);
            emit(l.network_start + n.energy_row(cell), col, receipt.energy[0]);
            emit(
                l.network_start + n.marker_row(cell),
                col,
                -(material[1] + material[2]) / self.pressure_connection.atoms_per_marker,
            );
            if let Some(row) = n.mechanical_row(cell) {
                emit(l.network_start + row, col, receipt.mass[0]);
            }
            for k in 0..wc::WIDTH {
                emit(primary + k, col, -material[k]);
            }
            for (k, &v) in material[3..9].iter().enumerate() {
                emit(l.surge_carrier_start + k, col, -v);
            }
            emit(l.gas_hydrogen_product, col, -material[9]);
            emit(
                l.ambient_exported,
                col,
                -phase[cp::DIAGNOSTIC_AMBIENT_HEAT] - receipt.ambient_heat,
            );
        }
        for r in l.surge_carrier_start..l.dimension {
            emit(r, r, cj);
        }
        Ok(())
    }
}

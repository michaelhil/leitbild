//! Fixed provisional cold-join qualification, not a plant safety or empirical
//! error certificate. Reuses the SAME source-consequences-1 comparison. Local
//! deposited powers are compared separately from SG-scale thermal redistribution.
use super::{finite, quote, ratio, source_accuracy, source_pair, COUNT_ATOL, ENERGY_ATOL};
use leitbild_plant_numerics::{
    cold_pressurizer as cp, finite_surge as fs, operating_admission,
    source_cooling::Model,
    source_evolution::{Diagnostics, Workspace as SourceWorkspace},
    water_carrier as wc,
};

pub(super) const POLICY: &str = "cold-source-nuclear-heat";
pub(super) const CARRIER_POLICY: &str = "closed-mobile-generated-products-separate-H-B;local-remaining-targets;local-product-distribution-diagnostic";
pub(super) const OUTPUTS: [f64; 14] = [
    0.001, 0.01, 0.1, 1., 2., 5., 10., 20., 30., 60., 120., 180., 240., 300.,
];
pub(super) const TEMPERATURE_ATOL: f64 = 1e-3;
const TEMPERATURE_PAIR: f64 = 0.01;
pub(super) const DEPOSIT_RESOLUTION_W: f64 = 1e-12;
pub(super) const PRESSURE_RESOLUTION_PA: f64 = 1.;
/// Prospective absolute resolution of the actual algebraic mass flows, kg/s.
/// This is not the discarded momentum impulse or an inertia-error theorem.
pub(super) const SURGE_FLOW_RESOLUTION: f64 = 1e-5;

/// Current coupled chart correction, not F_i/J_ii or a projected state.
/// PZR order: Tl,Tg,ps,pv,H,Ti,pL; surge order: P,T.
pub(super) fn pressure_level_head_scale(
    model: &Model,
    y: &[f64],
    work: &cp::Workspace,
) -> Result<f64, String> {
    if y.len() != model.dimension() {
        return Err("Pressure level state shape".into());
    }
    let start = model.layout.pressurizer_start;
    // This cold domain keeps H at3–6m: the actual prepared hydrostatic head
    // is tens of kPa, not a tiny subtraction. No new EOS request or copied law.
    let scale = (work.diagnostics()?.bottom_pressure - y[start + cp::SURFACE_PRESSURE])
        / y[start + cp::HEIGHT];
    if !scale.is_finite() || scale <= 0. {
        return Err("Invalid owned liquid head scale".into());
    }
    Ok(scale)
}
pub(super) fn pressure_chart_ratio(
    pzr: &[f64; 7],
    surge: &[f64; 2],
    level_head_scale: f64,
) -> Result<f64, String> {
    if pzr.iter().chain(surge).any(|v| !v.is_finite())
        || !level_head_scale.is_finite()
        || level_head_scale <= 0.
    {
        return Err("Nonfinite pressure chart correction/head scale".into());
    }
    let temperature = [pzr[0], pzr[1], pzr[5], surge[1]]
        .into_iter()
        .map(|v| v.abs() / 1e-4)
        .fold(0., f64::max);
    let pressure = [pzr[2], pzr[3], pzr[6], surge[0]]
        .into_iter()
        .map(|v| v.abs() / PRESSURE_RESOLUTION_PA)
        .fold(0., f64::max);
    Ok(temperature
        .max(pressure)
        .max(pzr[4].abs() * level_head_scale / PRESSURE_RESOLUTION_PA))
}
pub(super) fn check_pressure_chart(
    _model: &Model,
    pzr: &[f64; 7],
    surge: &[f64; 2],
    level_head_scale: f64,
) -> Result<(), String> {
    let ratio = pressure_chart_ratio(pzr, surge, level_head_scale)?;
    if ratio > 1. {
        Err(format!("Current pressure chart refused: ratio={ratio}"))
    } else {
        Ok(())
    }
}

pub(super) struct Sample {
    pub time: f64,
    pub y: Vec<f64>,
    pub source_d: Diagnostics,
    pub source_captures: Vec<f64>,
    pub source_nc: Vec<f64>,
    pub deposition: Vec<f64>,
    pub water_mass: Vec<f64>,
    /// Emitted, nuclear-only barrel self/electron heat, export, then
    /// recipient-water photon heat. Sensible contact heat is NOT in this vector.
    pub barrel_power: Vec<f64>,
    /// Nuclear-only emitted/self/clad/water/export powers, per actual source
    /// intersection; sensible heat cannot conceal a missing binding path.
    pub capture_power: Vec<f64>,
    pub mobile_power: Vec<f64>,
    pub mobile_recipient_power: Vec<f64>,
    pub bundle_power: Vec<f64>,
    /// Actual signed algebraic mass flows, independently retained at both ends.
    pub surge_flow: [f64; 2],
}
impl Sample {
    fn source<'a>(&'a self, model: &Model) -> source_pair::SourceSample<'a> {
        source_pair::SourceSample {
            time: self.time,
            y: &self.y[..model.layout.source_end],
            d: self.source_d,
            captured_targets: &self.source_captures,
            nc_coefficients: &self.source_nc,
        }
    }
}
pub(super) struct Accuracy {
    pub source: source_accuracy::Accuracy,
    normal_absolute: Vec<f64>,
    flow_absolute: Vec<f64>,
    initial: Vec<f64>,
    initial_network_totals: [f64; 3],
    thermal_capacity: Vec<f64>,
    energy_rows: Vec<(usize, f64)>,
    carrier_q: [f64; 2],
    carrier_atoms_per_marker: f64,
    barrel_capacity: f64,
    pressure_energy_rows: Vec<(usize, f64)>,
}
fn product_resolution(reference: f64, q: f64) -> Result<f64, String> {
    if !reference.is_finite() || reference < 0. || !q.is_finite() || q < 0. {
        return Err("Invalid carrier reference/Q".into());
    }
    let result = if reference == 0. {
        COUNT_ATOL
    } else {
        let cap = 1e-3 * reference / 20.;
        if q == 0. {
            cap
        } else {
            cap.min(ENERGY_ATOL / q)
        }
    };
    if !result.is_finite() || result <= 0. {
        return Err("Invalid carrier consequence resolution".into());
    }
    Ok(result)
}
impl Accuracy {
    /// Disjoint PRHR bank first law. Unlike bank-to-pool heat, this cannot
    /// credit cooling of initially warm installed bank water/steel as primary
    /// heat removal. WST/ROOM/spring are deliberately not bank stocks.
    pub fn prhr_heat_receipts(
        &self,
        model: &Model,
        y: &[f64],
    ) -> Result<(f64, f64, f64, usize, usize), String> {
        if y.len() != self.initial.len() {
            return Err("Wrong PRHR heat receipt shape".into());
        }
        let p = model
            .network
            .prhr()
            .ok_or("Missing PRHR heat receipt owner")?;
        let base = model.layout.network_start;
        let waters = p
            .config
            .liquid_contacts
            .iter()
            .map(|c| c.water)
            .collect::<std::collections::BTreeSet<_>>();
        let steels = p
            .config
            .liquid_contacts
            .iter()
            .map(|c| c.solid)
            .chain(p.config.pool_contacts.iter().map(|c| c.solid))
            .chain(p.config.gas_contacts.iter().map(|c| c.solid))
            .collect::<std::collections::BTreeSet<_>>();
        let nw = model.network.config().water.len();
        let bank_rows = waters
            .iter()
            .map(|&i| base + model.network.energy_row(i))
            .chain(
                steels
                    .iter()
                    .map(|&i| base + model.network.energy_row(nw + i)),
            )
            .collect::<Vec<_>>();
        let pool = base + p.layout.wst_start + leitbild_plant_numerics::finite_wst::ENERGY;
        let gas = base + p.layout.gas_exported;
        let connector = base + p.layout.connector_exported;
        let delta = |row| y[row] - self.initial[row];
        let bank_to_pool = delta(pool) + delta(gas);
        let bank_change = bank_rows.iter().map(|&r| delta(r)).sum::<f64>();
        let net_primary = bank_change + bank_to_pool + delta(connector);
        let operand_magnitude = bank_rows
            .iter()
            .chain([pool, gas, connector].iter())
            .map(|&r| y[r].abs() + self.initial[r].abs())
            .sum::<f64>();
        // Solver stock weights are not an integrated-output error bound. Use
        // the existing receipt resolution plus explicit cancellation scale;
        // independent normal/tighter signal comparison remains compulsory.
        let resolution = 20. * (self.normal_absolute[gas] + self.normal_absolute[connector])
            + 4096. * f64::EPSILON * operand_magnitude;
        if [bank_to_pool, net_primary, resolution]
            .iter()
            .any(|x| !x.is_finite())
            || resolution <= 0.
        {
            return Err("Nonfinite actual PRHR subset heat receipt".into());
        }
        Ok((
            bank_to_pool,
            net_primary,
            resolution,
            waters.len(),
            steels.len(),
        ))
    }
    pub fn prhr_ledgers(&self, model: &Model, y: &[f64]) -> Result<(), String> {
        if y.len() != self.initial.len() {
            return Err("Wrong finite WST mass audit shape".into());
        }
        if let Some(p) = model.network.prhr() {
            let mass = model.layout.network_start + p.layout.wst_start;
            let export = model.layout.network_start + p.layout.gas_mass_exported;
            let defect = (y[mass] - self.initial[mass]) + (y[export] - self.initial[export]);
            if !defect.is_finite() || defect.abs() > 1e-4 {
                return Err(format!(
                    "Finite WST/supplied gas mass ledger defect {defect} kg"
                ));
            }
            let rows = [
                (p.layout.room_energy, 1.),
                (p.layout.room_ambient_exported, 1.),
                (p.layout.electrical_received, -1.),
                (p.layout.spring_released, -1.),
            ];
            let mut room_defect = 0.;
            let mut operands = 0.;
            for (row, sign) in rows {
                let row = model.layout.network_start + row;
                room_defect += sign * (y[row] - self.initial[row]);
                operands += y[row].abs() + self.initial[row].abs();
            }
            let bound = 0.01 + 4096. * f64::EPSILON * operands;
            if !room_defect.is_finite() || room_defect.abs() > bound {
                return Err(format!("Finite PRHR ROOM.A/spring/support first-law defect {room_defect} J (bound{bound})"));
            }
        }
        Ok(())
    }
    pub fn new(
        model: &Model,
        emissions: &[[f64; 2]],
        input: Option<leitbild_plant_numerics::prhr::Input>,
    ) -> Result<Self, String> {
        let initial = model.initial_state_with_prhr_input(input)?;
        let mut work = model.workspace();
        model.evaluate_with_prhr_input(
            &initial,
            &vec![0.; model.dimension()],
            None,
            &mut work,
            input,
        )?;
        let source = source_accuracy::Accuracy::new(&model.source, emissions)?;
        let network = operating_admission::weights(
            &model.network,
            &work.network,
            &initial[model.layout.network_start..model.layout.carrier_start],
            300.,
            1.,
        )?;
        let l = model.layout;
        let mut absolute = vec![0.; model.dimension()];
        absolute[..l.source_end].copy_from_slice(&source.absolute(1.)?);
        absolute[l.network_start..l.carrier_start].copy_from_slice(&network.absolute);
        let law = model.source.moderator_law();
        let carrier_q = [
            law.hydrogen_emission.iter().sum(),
            law.boron_emission.iter().sum(),
        ];
        let href = model.carrier.hydrogen_per_kg();
        for (i, &mass) in work.network.chart_mass.iter().enumerate() {
            let start = l.carrier_start + leitbild_plant_numerics::water_carrier::WIDTH * i;
            absolute[start] = product_resolution(href * mass, carrier_q[0])?;
            absolute[start + 1] = COUNT_ATOL;
            absolute[start + 2] =
                product_resolution(model.carrier.initial()[i].boron10, carrier_q[1])?;
        }
        let thermal_capacity = work.thermal.capacities()?.to_vec();
        for (i, &c) in thermal_capacity.iter().enumerate() {
            absolute[l.energies_start + i] = c * TEMPERATURE_ATOL;
            absolute[l.temperatures_start + i] = TEMPERATURE_ATOL;
        }
        let barrel_capacity = model.barrel.heat_capacity(initial[l.barrel_temperature])?;
        absolute[l.barrel_energy] = barrel_capacity * TEMPERATURE_ATOL;
        absolute[l.barrel_temperature] = TEMPERATURE_ATOL;
        absolute[l.barrel_released] = ENERGY_ATOL;
        absolute[l.barrel_exported] = ENERGY_ATOL;
        absolute[l.fuel_capture_exported] = ENERGY_ATOL;
        absolute[l.mobile_capture_exported] = ENERGY_ATOL;
        absolute[l.mobile_capture_boundary_exported] = ENERGY_ATOL;
        for (i,&capacity) in work.absorber_guide.capacity.iter().enumerate(){
            absolute[l.absorber_guide_energies_start+i]=capacity*TEMPERATURE_ATOL;
            absolute[l.absorber_guide_temperatures_start+i]=TEMPERATURE_ATOL;
        }
        absolute[l.absorber_guide_exported]=ENERGY_ATOL;
        for (row,q) in model.absorber_guide.paid_rows(){
            absolute[row]=absolute[row].min(ENERGY_ATOL/q);
        }
        for (row, q) in model.capture_paid_rows() {
            absolute[row] = absolute[row].min(ENERGY_ATOL / q);
        }
        // The added finite stores use their actual caloric capacities, not
        // nuclear-receipt weights or an absolute-pressure display tolerance.
        let pressure = model.pressure_connection();
        let ps = l.pressurizer_start;
        let ss = l.surge_start;
        let input = pressure.pressurizer.input();
        let mut liquids = [leitbild_plant_numerics::Liquid::default(); 2];
        leitbild_plant_numerics::liquid_batch(
            &[
                leitbild_plant_numerics::LiquidQuery {
                    pressure: initial[ps + cp::LIQUID_PRESSURE],
                    temperature: initial[ps + cp::LIQUID_TEMPERATURE],
                },
                leitbild_plant_numerics::LiquidQuery {
                    pressure: initial[ss + fs::PRESSURE],
                    temperature: initial[ss + fs::TEMPERATURE],
                },
            ],
            &mut liquids,
        )
        .map_err(|e| e.message)?;
        let pool_capacity = initial[ps + cp::LIQUID_MASS] * liquids[0].cv;
        let gas_capacity = initial[ps + cp::VAPOR_MASS] * pressure.pressurizer.steam().cv
            + input.air_mass * leitbild_plant_numerics::sg_secondary::CVA
            + input.nitrogen_mass * leitbild_plant_numerics::sg_secondary::CVN;
        let mut pressure_energy_rows = vec![
            (ps + cp::LIQUID_ENERGY, pool_capacity),
            (ps + cp::GAS_ENERGY, gas_capacity),
            (ss + fs::ENERGY, initial[ss + fs::MASS] * liquids[1].cv),
            (
                ss + fs::STEEL_ENERGY,
                pressure
                    .surge
                    .steel_capacity(initial[ss + fs::STEEL_TEMPERATURE]),
            ),
        ];
        for k in 0..cp::METALS {
            pressure_energy_rows.push((
                ps + cp::METAL_ENERGY_START + k,
                pressure
                    .pressurizer
                    .metal_capacity(k, initial[ps + cp::METAL_TEMPERATURE_START + k])?,
            ));
        }
        for &(row, capacity) in &pressure_energy_rows {
            absolute[row] = capacity * TEMPERATURE_ATOL;
        }
        for row in [
            cp::LIQUID_TEMPERATURE,
            cp::GAS_TEMPERATURE,
            cp::INTERFACE_TEMPERATURE,
        ] {
            absolute[ps + row] = TEMPERATURE_ATOL;
        }
        for k in 0..cp::METALS {
            absolute[ps + cp::METAL_TEMPERATURE_START + k] = TEMPERATURE_ATOL;
        }
        for row in [fs::TEMPERATURE, fs::STEEL_TEMPERATURE] {
            absolute[ss + row] = TEMPERATURE_ATOL;
        }
        for row in [
            cp::SURFACE_PRESSURE,
            cp::VAPOR_PRESSURE,
            cp::LIQUID_PRESSURE,
        ] {
            absolute[ps + row] = 1.;
        }
        absolute[ss + fs::PRESSURE] = 1.;
        absolute[l.network_start + model.network.pressure_row()] = 1.;
        for i in 0..model.network.config().water.len() {
            if let Some(row) = model.network.mechanical_row(i) {
                absolute[l.network_start + row] = 1.;
            }
        }
        absolute[ps + cp::LIQUID_MASS] = 1e-5;
        // One Pa of vapor's forward partial-pressure chart, not one Pa
        // relative to the much larger air-supported total pressure.
        absolute[ps + cp::VAPOR_MASS] = (work.pressurizer.diagnostics()?.gas_volume
            / (pressure.pressurizer.steam().gas_constant * initial[ps + cp::GAS_TEMPERATURE]))
            .min(1e-5);
        absolute[ps + cp::HEIGHT] = 1. / (liquids[0].density * leitbild_plant_numerics::GRAVITY);
        absolute[ss + fs::MASS] = 1e-5;
        absolute[ss + fs::LEFT_FLOW] = SURGE_FLOW_RESOLUTION;
        absolute[ss + fs::RIGHT_FLOW] = SURGE_FLOW_RESOLUTION;
        for (start, mass, amounts) in [
            (
                l.surge_carrier_start,
                initial[ss + fs::MASS],
                pressure.initial_line,
            ),
            (
                l.pool_carrier_start,
                initial[ps + cp::LIQUID_MASS],
                pressure.initial_pool,
            ),
        ] {
            absolute[start] = product_resolution(href * mass, carrier_q[0])?;
            absolute[start + 1] = COUNT_ATOL;
            absolute[start + 2] = product_resolution(amounts.boron10, carrier_q[1])?;
        }
        absolute[l.gas_hydrogen_product] =
            product_resolution(href * initial[ps + cp::VAPOR_MASS], carrier_q[0])?;
        // Ambient exchange is a sensible-heat receipt, not a tiny nuclear
        // event count. The independent total-energy defect remains mandatory.
        absolute[l.ambient_exported] = 1.;
        if absolute.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err("Invalid cold-join absolute weights".into());
        }
        let n = &model.network;
        let nw = n.config().water.len();
        let ns = n.config().solids.len();
        let mut energy_rows = (0..nw + ns)
            .map(|i| {
                let row = n.energy_row(i);
                (
                    l.network_start + row,
                    network.absolute[row] / TEMPERATURE_ATOL,
                )
            })
            .collect::<Vec<_>>();
        energy_rows.extend((0..n.config().secondaries.len()).map(|k| {
            let row = n.secondary_energy_row(k);
            (
                l.network_start + row,
                network.absolute[row] / TEMPERATURE_ATOL,
            )
        }));
        if let Some(p) = n.prhr() {
            energy_rows.extend(p.energy_rows().map(|row| {
                (
                    l.network_start + row,
                    network.absolute[row] / TEMPERATURE_ATOL,
                )
            }));
        }
        let initial_network_totals =
            operating_admission::totals(n, &initial[l.network_start..l.carrier_start]);
        let total = model
            .carrier
            .initial()
            .iter()
            .map(|a| a.boron10 + a.boron)
            .sum::<f64>();
        let marker0 = (0..model.carrier.cells())
            .map(|i| initial[l.network_start + n.marker_row(i)])
            .sum::<f64>();
        // One immutable packet conversion owns physics and qualification.
        // Preparation consistency is not a dynamic local marker equality gate.
        let carrier_atoms_per_marker = model.pressure_connection().atoms_per_marker;
        let prepared_conversion = total / marker0;
        if !total.is_finite()
            || total <= 0.
            || !marker0.is_finite()
            || marker0 <= 0.
            || !carrier_atoms_per_marker.is_finite()
            || carrier_atoms_per_marker <= 0.
            || (prepared_conversion / carrier_atoms_per_marker - 1.).abs() > 64. * f64::EPSILON
        {
            return Err(
                "Closed carrier ledger requires actual positive B/marker preparation".into(),
            );
        }
        Ok(Self {
            source,
            normal_absolute: absolute,
            flow_absolute: network.flow,
            initial,
            initial_network_totals,
            thermal_capacity,
            energy_rows,
            carrier_q,
            carrier_atoms_per_marker,
            barrel_capacity,
            pressure_energy_rows,
        })
    }
    pub fn absolute(&self, refinement: f64) -> Result<Vec<f64>, String> {
        refined(&self.normal_absolute, refinement)
    }
    pub fn flow_absolute(&self, refinement: f64) -> Result<Vec<f64>, String> {
        refined(&self.flow_absolute, refinement)
    }
    /// Global connected liquid B-target-plus-product conservation in the existing
    /// equivalent marker units. Local tracer agreement is not this global
    /// conservation criterion; routing is tested independently at RHS/JVP level.
    pub fn carrier_ledger(&self, model: &Model, y: &[f64]) -> Result<f64, String> {
        if y.len() != self.initial.len() {
            return Err("Wrong closed carrier ledger shape".into());
        }
        let l = model.layout;
        let conversion = self.carrier_atoms_per_marker;
        let mut change = 0f64;
        for start in (0..model.carrier.cells())
            .map(|i| l.carrier_start + wc::WIDTH * i)
            .chain([l.surge_carrier_start, l.pool_carrier_start])
        {
            let delta = ((y[start + 1] - self.initial[start + 1])
                + (y[start + 2] - self.initial[start + 2]))
                / conversion;
            change += delta;
            if !delta.is_finite() || !change.is_finite() {
                return Err("Nonfinite closed carrier ledger".into());
            }
        }
        let defect = change.abs();
        if !defect.is_finite() || defect > 1e-8 {
            return Err(format!(
                "Global closed direct-boron ledger refused: {defect} kg-equivalent"
            ));
        }
        Ok(defect)
    }
    /// Installed energy receives independent fuel/barrel release less photon
    /// export. Fuel/He and barrel energy changes leave the network expectation;
    /// the release/export audit coordinates are not extra sensible stores.
    pub fn expected_network_totals(&self, model: &Model, y: &[f64]) -> Result<[f64; 3], String> {
        if y.len() != self.initial.len() {
            return Err("Wrong cold-join energy shape".into());
        }
        let l = model.layout;
        let solid_change = y[l.energies_start..l.temperatures_start]
            .iter()
            .zip(&self.initial[l.energies_start..l.temperatures_start])
            .map(|(a, b)| a - b)
            .sum::<f64>();
        let released =
            y[model.source.fuel_release_row()] - self.initial[model.source.fuel_release_row()];
        let mut totals = self.initial_network_totals;
        let barrel_paid = (y[l.barrel_released] - self.initial[l.barrel_released])
            - (y[l.barrel_exported] - self.initial[l.barrel_exported]);
        let binding_paid = super::cooling_capture::paid_energy(model, y, &self.initial)?
            - (y[l.fuel_capture_exported] - self.initial[l.fuel_capture_exported]);
        let mobile_paid = super::cooling_mobile::paid_energy(model, y, &self.initial)?
            - (y[l.mobile_capture_exported] - self.initial[l.mobile_capture_exported])
            - (y[l.mobile_capture_boundary_exported]
                - self.initial[l.mobile_capture_boundary_exported]);
        let bundle_paid=super::cooling_bundle::paid(model,y,&self.initial)?
            -(y[l.absorber_guide_exported]-self.initial[l.absorber_guide_exported]);
        let bundle_change=y[l.absorber_guide_energies_start..l.absorber_guide_temperatures_start].iter()
            .zip(&self.initial[l.absorber_guide_energies_start..l.absorber_guide_temperatures_start])
            .map(|(a,b)|a-b).sum::<f64>();
        totals[1] += released + barrel_paid + binding_paid + mobile_paid +bundle_paid-bundle_change
            - solid_change
            - (y[l.barrel_energy] - self.initial[l.barrel_energy])
            - self
                .pressure_energy_rows
                .iter()
                .map(|(row, _)| y[*row] - self.initial[*row])
                .sum::<f64>()
            - (y[l.ambient_exported] - self.initial[l.ambient_exported]);
        for row in [
            l.surge_start + fs::MASS,
            l.pressurizer_start + cp::LIQUID_MASS,
            l.pressurizer_start + cp::VAPOR_MASS,
        ] {
            totals[0] -= y[row] - self.initial[row];
        }
        for start in [l.surge_carrier_start, l.pool_carrier_start] {
            totals[2] -= ((y[start + 1] - self.initial[start + 1])
                + (y[start + 2] - self.initial[start + 2]))
                / self.carrier_atoms_per_marker;
        }
        if totals.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite installed thermal expectation".into());
        }
        Ok(totals)
    }
    pub fn compare_one(&self, model: &Model, a: &Sample, b: &Sample) -> Result<Comparison, String> {
        if a.time != b.time
            || !a.time.is_finite()
            || a.time <= 0.
            || a.y.len() != model.dimension()
            || b.y.len() != model.dimension()
            || a.water_mass.len() != model.carrier.cells()
            || b.water_mass.len() != model.carrier.cells()
            || a.surge_flow
                .iter()
                .chain(&b.surge_flow)
                .any(|v| !v.is_finite())
            || a.y
                .iter()
                .chain(&b.y)
                .chain(&a.water_mass)
                .chain(&b.water_mass)
                .any(|v| !v.is_finite())
        {
            return Err("Invalid cold-join common output".into());
        }
        let source = source_pair::PairComparator::new(&model.source, &self.source).compare(
            &model.source,
            &a.source(model),
            &b.source(model),
        )?;
        let mut result = Comparison {
            source,
            thermal_temperature_ratio: 0.,
            thermal_energy_ratio: 0.,
            thermal_family_ratio: 0.,
            network_temperature_ratio: 0.,
            network_pressure_ratio: 0.,
            secondary_mass_ratio: 0.,
            sg_heat_ratio: 0.,
            prhr_pair_ratio: 0.,
            carrier_ratio: 0.,
            carrier_product_distribution_ratio: 0.,
            carrier_product_distribution_worst: None,
            carrier_generated_totals: String::new(),
            deposit_local_ratio: 0.,
            deposit_sumabs_ratio: 0.,
            max_temperature_change: 0.,
            max_temperature_difference: 0.,
            barrel_thermal_ratio: 0.,
            barrel_power_ratio: 0.,
            capture_power_local_ratio: 0.,
            capture_power_sumabs_ratio: 0.,
            capture_paid_energy_ratio: 0.,
            mobile_power_local_ratio: 0.,
            mobile_power_sumabs_ratio: 0.,
            mobile_paid_energy_ratio: 0.,
            mobile_details: String::new(),
            capture_details: String::new(),
            prhr_details: "null".into(),
            barrel_details: String::new(),
            pressure_pair_ratio: 0.,
            pressure_material_pair_ratio: 0.,
            max_pressure_change: 0.,
            max_pressure_difference: 0.,
            worst: None,
        };
        let l = model.layout;
        let bundle=super::cooling_bundle::compare(model,a,b,&self.initial,Some(&mut result))?;
        result.deposit_local_ratio=result.deposit_local_ratio.max(bundle.0);
        result.deposit_sumabs_ratio=result.deposit_sumabs_ratio.max(bundle.1);
        result.capture_paid_energy_ratio=result.capture_paid_energy_ratio.max(bundle.2);
        for (i,host) in model.absorber_guide.config().hosts.iter().enumerate(){
            let row=l.absorber_guide_temperatures_start+i;
            result.thermal_temperature_ratio=result.thermal_temperature_ratio.max(result.record(
                "finite-BODY-guide-temperature",row,a.y[row],b.y[row],(a.y[row]-b.y[row]).abs(),0.01)?);
            let row=l.absorber_guide_energies_start+i;
            let capacity=model.absorber_guide.energy_capacity(i,host.initial_k)?.1;
            result.thermal_energy_ratio=result.thermal_energy_ratio.max(result.record(
                "finite-BODY-guide-energy",row,a.y[row],b.y[row],(a.y[row]-b.y[row]).abs(),20.*capacity*TEMPERATURE_ATOL)?);
        }
        self.compare_pressure(model, a, b, &mut result)?;
        let mobile_channels = 12 * model.mobile_capture.route_count();
        if mobile_channels == 0
            || a.mobile_power.len() != mobile_channels
            || b.mobile_power.len() != mobile_channels
        {
            return Err("Wrong birth-site mobile-capture power sample shape".into());
        }
        let (local, sumabs) = deposit_comparison(&a.mobile_power, &b.mobile_power)?;
        result.mobile_power_local_ratio = local.0;
        result.mobile_power_sumabs_ratio = sumabs;
        let i = local.1;
        result.record(
            "mobile-binding-birth-route-species-power-W",
            i,
            a.mobile_power[i],
            b.mobile_power[i],
            (a.mobile_power[i] - b.mobile_power[i]).abs(),
            1e-3 * b.mobile_power[i].abs() + 20. * DEPOSIT_RESOLUTION_W,
        )?;
        let recipients = model.carrier.cells() + model.thermal.node_count() + 1 + model.absorber_guide.host_count();
        if a.mobile_recipient_power.len() != recipients
            || b.mobile_recipient_power.len() != recipients
        {
            return Err("Wrong finite mobile-binding recipient sample shape".into());
        }
        let (local, sumabs) =
            deposit_comparison(&a.mobile_recipient_power, &b.mobile_recipient_power)?;
        result.mobile_power_local_ratio = result.mobile_power_local_ratio.max(local.0);
        result.mobile_power_sumabs_ratio = result.mobile_power_sumabs_ratio.max(sumabs);
        let i = local.1;
        result.record(
            "mobile-binding-finite-water-clad-barrel-BODY-guide-power-W",
            i,
            a.mobile_recipient_power[i],
            b.mobile_recipient_power[i],
            (a.mobile_recipient_power[i] - b.mobile_recipient_power[i]).abs(),
            1e-3 * b.mobile_recipient_power[i].abs() + 20. * DEPOSIT_RESOLUTION_W,
        )?;
        let paid_a = super::cooling_mobile::paid_species(model, &a.y, &self.initial)?;
        let paid_b = super::cooling_mobile::paid_species(model, &b.y, &self.initial)?;
        for species in 0..2 {
            result.mobile_paid_energy_ratio = result.mobile_paid_energy_ratio.max(result.record(
                if species == 0 {
                    "mobile-H-binding-total-paid-J"
                } else {
                    "mobile-B-binding-total-paid-J"
                },
                species,
                paid_a[species],
                paid_b[species],
                (paid_a[species] - paid_b[species]).abs(),
                1e-3 * paid_b[species].abs() + 20. * ENERGY_ATOL,
            )?);
        }
        let exports = [
            l.mobile_capture_exported,
            l.mobile_capture_boundary_exported,
        ];
        let export_a = exports.map(|r| a.y[r] - self.initial[r]);
        let export_b = exports.map(|r| b.y[r] - self.initial[r]);
        for (k, row) in exports.into_iter().enumerate() {
            result.mobile_paid_energy_ratio = result.mobile_paid_energy_ratio.max(result.record(
                if k == 0 {
                    "mobile-binding-installed-wall-exit-J"
                } else {
                    "mobile-binding-unrepresented-wall-boundary-J"
                },
                row,
                export_a[k],
                export_b[k],
                (export_a[k] - export_b[k]).abs(),
                1e-3 * export_b[k].abs() + 20. * ENERGY_ATOL,
            )?);
        }
        result.mobile_details = format!("{{\"policy\":{},\"routeCount\":{},\"wallOriginCount\":{},\"speciesOrder\":[\"H\",\"B\"],\"channelOrder\":[\"emitted\",\"charged-liquid\",\"liquid-photon\",\"installed-wall\",\"beyond-installed-wall-export\",\"unrepresented-wall-boundary-export\"],\"normalPaidSpeciesJ\":{},\"tighterPaidSpeciesJ\":{},\"normalExclusiveExportsJ\":{},\"tighterExclusiveExportsJ\":{},\"normalSpeciesPowerTotalsW\":{},\"tighterSpeciesPowerTotalsW\":{},\"normalFiniteRecipientPowerW\":{},\"tighterFiniteRecipientPowerW\":{}}}",
            super::quote(super::cooling_mobile::POLICY), model.mobile_capture.route_count(), model.mobile_capture.origin_count(),
            super::numbers(&paid_a), super::numbers(&paid_b), super::numbers(&export_a), super::numbers(&export_b),
            super::numbers(&super::cooling_mobile::power_totals(&a.mobile_power)?),
            super::numbers(&super::cooling_mobile::power_totals(&b.mobile_power)?),
            finite(a.mobile_recipient_power.iter().sum()),finite(b.mobile_recipient_power.iter().sum()));
        let channels = 5 * model.source.fuel_history().fuel().intersections().len();
        if a.capture_power.len() != channels || b.capture_power.len() != channels {
            return Err("Wrong fuel-binding power sample shape".into());
        }
        let (local, sumabs) = deposit_comparison(&a.capture_power, &b.capture_power)?;
        result.capture_power_local_ratio = local.0;
        result.capture_power_sumabs_ratio = sumabs;
        let i = local.1;
        result.record(
            "fuel-binding-emitted-self-clad-water-export-W",
            i,
            a.capture_power[i],
            b.capture_power[i],
            (a.capture_power[i] - b.capture_power[i]).abs(),
            1e-3 * b.capture_power[i].abs() + 20. * DEPOSIT_RESOLUTION_W,
        )?;
        let paid_a = super::cooling_capture::paid_energy(model, &a.y, &self.initial)?;
        let paid_b = super::cooling_capture::paid_energy(model, &b.y, &self.initial)?;
        let exported_a = a.y[l.fuel_capture_exported] - self.initial[l.fuel_capture_exported];
        let exported_b = b.y[l.fuel_capture_exported] - self.initial[l.fuel_capture_exported];
        let (mut paid_error, mut paid_signal, mut paid_rows) = (0., 0., 0usize);
        for (row, q) in model.capture_paid_rows() {
            let x = q * (a.y[row] - self.initial[row]);
            let y = q * (b.y[row] - self.initial[row]);
            let difference = q * (a.y[row] - b.y[row]).abs();
            result.capture_paid_energy_ratio =
                result.capture_paid_energy_ratio.max(result.record(
                    "fuel-binding-local-progress-energy-J",
                    row,
                    x,
                    y,
                    difference,
                    1e-3 * y.abs() + 20. * ENERGY_ATOL,
                )?);
            paid_error += difference;
            paid_signal += y.abs();
            paid_rows += 1;
        }
        result.capture_paid_energy_ratio = result.capture_paid_energy_ratio.max(ratio(
            paid_error,
            1e-3 * paid_signal + 20. * ENERGY_ATOL * paid_rows as f64,
        )?);
        for (family, x, y) in [
            ("fuel-binding-paid-energy-J", paid_a, paid_b),
            ("fuel-binding-exported-energy-J", exported_a, exported_b),
        ] {
            result.capture_paid_energy_ratio =
                result.capture_paid_energy_ratio.max(result.record(
                    family,
                    l.fuel_capture_exported,
                    x,
                    y,
                    (x - y).abs(),
                    1e-3 * y.abs() + 20. * ENERGY_ATOL,
                )?);
        }
        result.capture_details = format!("{{\"scope\":\"fuel-binding-only;not-fission-E25-or-sensible-heat\",\"channelOrder\":[\"emitted\",\"self\",\"clad\",\"water\",\"export\"],\"normalPaidEnergyJ\":{},\"tighterPaidEnergyJ\":{},\"normalExportedEnergyJ\":{},\"tighterExportedEnergyJ\":{},\"normalPowerTotalsW\":{},\"tighterPowerTotalsW\":{},\"normalPowerChannelsW\":{},\"tighterPowerChannelsW\":{}}}",
            finite(paid_a),finite(paid_b),finite(exported_a),finite(exported_b),
            super::numbers(&super::cooling_capture::power_totals(&a.capture_power)?),
            super::numbers(&super::cooling_capture::power_totals(&b.capture_power)?),
            super::numbers(&a.capture_power),super::numbers(&b.capture_power));
        result.barrel_thermal_ratio = result.record(
            "barrel-temperature",
            l.barrel_temperature,
            a.y[l.barrel_temperature],
            b.y[l.barrel_temperature],
            (a.y[l.barrel_temperature] - b.y[l.barrel_temperature]).abs(),
            TEMPERATURE_PAIR,
        )?;
        for (family, row, resolution) in [
            (
                "barrel-energy-change",
                l.barrel_energy,
                self.barrel_capacity * TEMPERATURE_ATOL,
            ),
            ("barrel-released-energy", l.barrel_released, ENERGY_ATOL),
            ("barrel-exported-energy", l.barrel_exported, ENERGY_ATOL),
        ] {
            let x = a.y[row] - self.initial[row];
            let y = b.y[row] - self.initial[row];
            result.barrel_thermal_ratio = result.barrel_thermal_ratio.max(result.record(
                family,
                row,
                x,
                y,
                (x - y).abs(),
                1e-3 * y.abs() + 20. * resolution,
            )?);
        }
        if a.barrel_power.len() != 3 + model.carrier.cells()
            || b.barrel_power.len() != a.barrel_power.len()
        {
            return Err("Wrong barrel power sample shape".into());
        }
        for (i, (&x, &y)) in a.barrel_power.iter().zip(&b.barrel_power).enumerate() {
            result.barrel_power_ratio = result.barrel_power_ratio.max(result.record(
                "barrel-emission-local-export-water-W",
                i,
                x,
                y,
                (x - y).abs(),
                1e-3 * y.abs() + 20. * DEPOSIT_RESOLUTION_W,
            )?);
        }
        result.barrel_details = format!(
            "{{\"scope\":\"nuclear-only-powers-separated-from-sensible-contacts\",\"normal\":{},\"tighter\":{}}}",
            barrel_details(model, a),
            barrel_details(model, b)
        );
        let mut thermal_error = 0.;
        let mut thermal_signal = 0.;
        let mut thermal_resolution = 0.;
        for (i, &c) in self.thermal_capacity.iter().enumerate() {
            let tr = l.temperatures_start + i;
            let er = l.energies_start + i;
            let dt = (a.y[tr] - b.y[tr]).abs();
            result.max_temperature_difference = result.max_temperature_difference.max(dt);
            result.max_temperature_change = result
                .max_temperature_change
                .max((b.y[tr] - self.initial[tr]).abs());
            result.thermal_temperature_ratio =
                result.thermal_temperature_ratio.max(result.record(
                    "thermal-temperature",
                    tr,
                    a.y[tr],
                    b.y[tr],
                    dt,
                    TEMPERATURE_PAIR,
                )?);
            let difference = (a.y[er] - b.y[er]).abs();
            let signal = (b.y[er] - self.initial[er]).abs();
            let resolution = 20. * c * TEMPERATURE_ATOL;
            result.thermal_energy_ratio = result.thermal_energy_ratio.max(result.record(
                "thermal-energy-change",
                er,
                a.y[er] - self.initial[er],
                b.y[er] - self.initial[er],
                difference,
                1e-3 * signal + resolution,
            )?);
            thermal_error += difference;
            thermal_signal += signal;
            thermal_resolution += resolution;
        }
        result.thermal_family_ratio =
            ratio(thermal_error, 1e-3 * thermal_signal + thermal_resolution)?;
        let n = &model.network;
        let an = &a.y[l.network_start..l.carrier_start];
        let bn = &b.y[l.network_start..l.carrier_start];
        let nw = n.config().water.len();
        let ns = n.config().solids.len();
        for i in 0..nw + ns {
            let x = n.temperature(i, an);
            let y = n.temperature(i, bn);
            result.network_temperature_ratio =
                result.network_temperature_ratio.max(result.record(
                    "network-temperature",
                    i,
                    x,
                    y,
                    (x - y).abs(),
                    TEMPERATURE_PAIR,
                )?);
        }
        for i in 0..nw {
            for (family, x, y) in [
                ("eos-pressure", n.eos_pressure(i, an), n.eos_pressure(i, bn)),
                (
                    "mechanical-pressure",
                    n.mechanical_pressure(i, an),
                    n.mechanical_pressure(i, bn),
                ),
            ] {
                result.network_pressure_ratio = result.network_pressure_ratio.max(result.record(
                    family,
                    i,
                    x,
                    y,
                    (x - y).abs(),
                    5000.,
                )?);
            }
        }
        let mut network_error = 0.;
        let mut network_signal = 0.;
        let mut network_resolution = 0.;
        for &(row, c) in &self.energy_rows {
            let difference = (a.y[row] - b.y[row]).abs();
            let signal = (b.y[row] - self.initial[row]).abs();
            let floor = 20. * c * TEMPERATURE_ATOL;
            result.thermal_energy_ratio = result.thermal_energy_ratio.max(result.record(
                "network-energy-change",
                row,
                a.y[row] - self.initial[row],
                b.y[row] - self.initial[row],
                difference,
                1e-3 * signal + floor,
            )?);
            network_error += difference;
            network_signal += signal;
            network_resolution += floor;
        }
        result.thermal_family_ratio = result.thermal_family_ratio.max(ratio(
            network_error,
            1e-3 * network_signal + network_resolution,
        )?);
        let mut sg_error = 0.;
        let mut sg_signal = 0.;
        for i in 0..ns {
            let row = l.network_start + n.energy_row(nw + i);
            sg_error += (a.y[row] - b.y[row]).abs();
            sg_signal += (b.y[row] - self.initial[row]).abs();
        }
        for k in 0..n.config().secondaries.len() {
            let tr = n.secondary_temperature_row(k);
            let pr = n.secondary_pressure_row(k);
            result.network_temperature_ratio =
                result.network_temperature_ratio.max(result.record(
                    "secondary-temperature",
                    k,
                    an[tr],
                    bn[tr],
                    (an[tr] - bn[tr]).abs(),
                    TEMPERATURE_PAIR,
                )?);
            result.network_pressure_ratio = result.network_pressure_ratio.max(result.record(
                "secondary-pressure",
                k,
                an[pr],
                bn[pr],
                (an[pr] - bn[pr]).abs(),
                5000.,
            )?);
            let sa =
                n.config().secondaries[k].evaluate(n.secondary_inventory(k), an[tr], an[pr])?;
            let sb =
                n.config().secondaries[k].evaluate(n.secondary_inventory(k), bn[tr], bn[pr])?;
            result.secondary_mass_ratio = result.secondary_mass_ratio.max(result.record(
                "secondary-liquid-mass",
                k,
                sa.liquid_mass,
                sb.liquid_mass,
                (sa.liquid_mass - sb.liquid_mass).abs(),
                0.01,
            )?);
            result.secondary_mass_ratio = result.secondary_mass_ratio.max(result.record(
                "secondary-vapor-mass",
                k,
                sa.vapor_mass,
                sb.vapor_mass,
                (sa.vapor_mass - sb.vapor_mass).abs(),
                0.01,
            )?);
            let row = l.network_start + n.secondary_energy_row(k);
            sg_error += (a.y[row] - b.y[row]).abs();
            sg_signal += (b.y[row] - self.initial[row]).abs();
        }
        if let Some(p) = n.prhr() {
            use leitbild_plant_numerics::finite_wst as fw;
            let q = p.layout;
            for (family, row, bound) in [
                ("prhr-pool-mass", q.wst_start + fw::MASS, 0.01),
                (
                    "prhr-pool-temperature",
                    q.wst_start + fw::TEMPERATURE,
                    TEMPERATURE_PAIR,
                ),
                ("prhr-pool-volume", q.wst_start + fw::VOLUME, 1e-5),
                ("prhr-signed-surface-mass-export", q.gas_mass_exported, 1e-4),
            ] {
                let r = result.record(
                    family,
                    row,
                    an[row],
                    bn[row],
                    (an[row] - bn[row]).abs(),
                    bound,
                )?;
                result.prhr_pair_ratio = result.prhr_pair_ratio.max(r);
            }
            for row in q.surface_start..q.spring_released {
                let r = result.record(
                    "prhr-film-surface-temperature",
                    row,
                    an[row],
                    bn[row],
                    (an[row] - bn[row]).abs(),
                    TEMPERATURE_PAIR,
                )?;
                result.prhr_pair_ratio = result.prhr_pair_ratio.max(r);
            }
            let room = p.config.actuator;
            let row = q.room_energy;
            let r = result.record(
                "prhr-room-temperature",
                row,
                an[row] / room.room_capacity_j_k,
                bn[row] / room.room_capacity_j_k,
                (an[row] - bn[row]).abs() / room.room_capacity_j_k,
                TEMPERATURE_PAIR,
            )?;
            result.prhr_pair_ratio = result.prhr_pair_ratio.max(r);
            for (row, _) in p.receipt_rows() {
                let global = l.network_start + row;
                let signal = (bn[row] - self.initial[global]).abs();
                let r = result.record(
                    "prhr-boundary-energy-receipt",
                    row,
                    an[row],
                    bn[row],
                    (an[row] - bn[row]).abs(),
                    1e-3 * signal + 20. * self.normal_absolute[global],
                )?;
                result.prhr_pair_ratio = result.prhr_pair_ratio.max(r);
            }
            // Actual bank heat excludes CNV condensation and connector export:
            // the pool energy equation gives Qbank=ΔEpool+surface/work export.
            // A capacity-sized temperature tolerance cannot hide this signal.
            let energy = l.network_start + q.wst_start + fw::ENERGY;
            let gas = l.network_start + q.gas_exported;
            let qa = (a.y[energy] - self.initial[energy]) + (a.y[gas] - self.initial[gas]);
            let qb = (b.y[energy] - self.initial[energy]) + (b.y[gas] - self.initial[gas]);
            let bound = 1e-3 * qb.abs() + 20. * self.normal_absolute[gas];
            let r = result.record(
                "prhr-actual-bank-to-pool-heat",
                energy,
                qa,
                qb,
                (qa - qb).abs(),
                bound,
            )?;
            result.prhr_pair_ratio = result.prhr_pair_ratio.max(r);
            let (_, na, resolution, water_owners, steel_owners) =
                self.prhr_heat_receipts(model, &a.y)?;
            let (_, nb, reference_resolution, _, _) = self.prhr_heat_receipts(model, &b.y)?;
            let resolution = resolution.max(reference_resolution);
            let net_bound = 1e-3 * nb.abs().max(na.abs()) + resolution;
            let net_ratio = result.record(
                "prhr-net-primary-to-bank-heat",
                energy,
                na,
                nb,
                (na - nb).abs(),
                net_bound,
            )?;
            result.prhr_pair_ratio = result.prhr_pair_ratio.max(net_ratio);
            result.prhr_details=format!("{{\"normalBankToPoolHeatJ\":{},\"tighterBankToPoolHeatJ\":{},\"pairedDifferenceJ\":{},\"pairedBoundJ\":{},\"normalNetPrimaryToPrhrHeatJ\":{},\"tighterNetPrimaryToPrhrHeatJ\":{},\"netPrimaryPairedDifferenceJ\":{},\"netPrimaryPairedBoundJ\":{},\"netPrimaryOperandResolutionJ\":{},\"bankWaterOwners\":{water_owners},\"bankSteelOwners\":{steel_owners},\"normalPoolEnergyChangeJ\":{},\"tighterPoolEnergyChangeJ\":{},\"normalSurfaceWorkExportJ\":{},\"tighterSurfaceWorkExportJ\":{},\"scope\":\"pool-first-law-plus-disjoint-bank-water-steel-first-law;CNV-surface-and-connector-receipts-separated;ROOM-spring-excluded\"}}",
                finite(qa),finite(qb),finite((qa-qb).abs()),finite(bound),finite(na),finite(nb),finite((na-nb).abs()),finite(net_bound),finite(resolution),finite(a.y[energy]-self.initial[energy]),
                finite(b.y[energy]-self.initial[energy]),finite(a.y[gas]-self.initial[gas]),finite(b.y[gas]-self.initial[gas]));
        }
        // Exact existing SG recipient SUMABS criterion; unlike recipients
        // cannot cancel, and the 1 J signal floor is not an added error floor.
        result.sg_heat_ratio = ratio(sg_error, 0.005 * sg_signal.max(1.))?;
        let href = model.carrier.hydrogen_per_kg();
        for i in 0..nw {
            for species in 0..2 {
                let start = l.carrier_start + leitbild_plant_numerics::water_carrier::WIDTH * i;
                let row = start + if species == 0 { 0 } else { 2 };
                let x = a.y[row];
                let y = b.y[row];
                let q = self.carrier_q[species];
                let (remaining_a, remaining_b, remaining_difference) = if species == 0 {
                    (
                        href * a.water_mass[i] - x,
                        href * b.water_mass[i] - y,
                        href * (a.water_mass[i] - b.water_mass[i]) - (x - y),
                    )
                } else {
                    (
                        a.y[start + 1],
                        b.y[start + 1],
                        a.y[start + 1] - b.y[start + 1],
                    )
                };
                let (energy, remaining) =
                    carrier_comparison(x, y, remaining_a, remaining_b, remaining_difference, q)?;
                result.record_product_distribution(
                    "mobile-capture-product-energy-equivalent-distribution",
                    row,
                    q * x,
                    q * y,
                    q * (x - y).abs(),
                    energy.1,
                )?;
                result.carrier_ratio = result.carrier_ratio.max(result.record(
                    "mobile-remaining-target",
                    row,
                    remaining_a,
                    remaining_b,
                    remaining_difference.abs(),
                    remaining.1,
                )?);
            }
        }
        // Transport cannot create another capture or repay its binding heat.
        // Compare generated products once over the CLOSED connected inventory,
        // separately by species; local depletion/current responses stay hard.
        let mut generated_details = Vec::with_capacity(2);
        for species in 0..2 {
            let q = self.carrier_q[species];
            let x = mobile_generated_energy(model, species, &a.y, &self.initial, q)?;
            let y = mobile_generated_energy(model, species, &b.y, &self.initial, q)?;
            let bound = 1e-3 * y.abs() + 20. * ENERGY_ATOL;
            let product_ratio = result.record(
                if species == 0 {
                    "closed-mobile-H-generated-product-energy"
                } else {
                    "closed-mobile-B-generated-product-energy"
                },
                species,
                x,
                y,
                (x - y).abs(),
                bound,
            )?;
            result.carrier_ratio = result.carrier_ratio.max(product_ratio);
            generated_details.push(format!("{{\"species\":\"{}\",\"owners\":{},\"normalJ\":{},\"tighterJ\":{},\"differenceJ\":{},\"boundJ\":{},\"ratio\":{}}}",if species == 0 { "H" } else { "B" },model.mobile_product_rows(species).count(),finite(x),finite(y),finite((x-y).abs()),finite(bound),finite(product_ratio)));
        }
        result.carrier_generated_totals = format!("[{}]", generated_details.join(","));
        if a.deposition.len() != model.fuel_rows().len()
            || b.deposition.len() != model.fuel_rows().len()
        {
            return Err("Wrong actual fuel-deposition dimension".into());
        }
        let (local, sumabs) = deposit_comparison(&a.deposition, &b.deposition)?;
        result.deposit_local_ratio = result.deposit_local_ratio.max(local.0);
        result.deposit_sumabs_ratio = result.deposit_sumabs_ratio.max(sumabs);
        if !a.deposition.is_empty() {
            let i = local.1;
            result.record(
                "fuel-cohort-deposition-W",
                i,
                a.deposition[i],
                b.deposition[i],
                (a.deposition[i] - b.deposition[i]).abs(),
                1e-3 * b.deposition[i].abs() + 20. * DEPOSIT_RESOLUTION_W,
            )?;
        }
        Ok(result)
    }
    fn compare_pressure(
        &self,
        model: &Model,
        a: &Sample,
        b: &Sample,
        result: &mut Comparison,
    ) -> Result<(), String> {
        let l = model.layout;
        let ps = l.pressurizer_start;
        let ss = l.surge_start;
        let pressure_rows = [
            l.network_start + model.network.pressure_row(),
            ss + fs::PRESSURE,
            ps + cp::SURFACE_PRESSURE,
            ps + cp::VAPOR_PRESSURE,
            ps + cp::LIQUID_PRESSURE,
        ];
        for row in pressure_rows {
            let x = a.y[row] - self.initial[row];
            let y = b.y[row] - self.initial[row];
            let difference = (x - y).abs();
            result.pressure_pair_ratio = result.pressure_pair_ratio.max(result.record(
                "cold-pressure-change-Pa",
                row,
                x,
                y,
                difference,
                0.005 * y.abs() + 1.,
            )?);
            // Developed response is the common primary pressure, not an
            // unrelated large constant offset or a different vapor channel.
            if row == l.network_start + model.network.pressure_row() {
                result.max_pressure_change = y.abs();
                result.max_pressure_difference = difference;
            }
        }
        let temperature_rows = [
            ps + cp::LIQUID_TEMPERATURE,
            ps + cp::GAS_TEMPERATURE,
            ps + cp::INTERFACE_TEMPERATURE,
            ss + fs::TEMPERATURE,
            ss + fs::STEEL_TEMPERATURE,
        ];
        for row in temperature_rows
            .into_iter()
            .chain((0..cp::METALS).map(|k| ps + cp::METAL_TEMPERATURE_START + k))
        {
            result.pressure_pair_ratio = result.pressure_pair_ratio.max(result.record(
                "pressure-support-temperature-K",
                row,
                a.y[row],
                b.y[row],
                (a.y[row] - b.y[row]).abs(),
                TEMPERATURE_PAIR,
            )?);
        }
        for &(row, c) in &self.pressure_energy_rows {
            let x = a.y[row] - self.initial[row];
            let y = b.y[row] - self.initial[row];
            result.pressure_pair_ratio = result.pressure_pair_ratio.max(result.record(
                "pressure-support-energy-change-J",
                row,
                x,
                y,
                (x - y).abs(),
                0.005 * y.abs() + 20. * c * TEMPERATURE_ATOL,
            )?);
        }
        for row in [
            ss + fs::MASS,
            ps + cp::LIQUID_MASS,
            ps + cp::VAPOR_MASS,
            ps + cp::HEIGHT,
            l.ambient_exported,
        ] {
            let x = a.y[row] - self.initial[row];
            let y = b.y[row] - self.initial[row];
            result.pressure_pair_ratio = result.pressure_pair_ratio.max(result.record(
                "pressure-support-mass-level-ambient-change",
                row,
                x,
                y,
                (x - y).abs(),
                0.005 * y.abs() + 20. * self.normal_absolute[row],
            )?);
        }
        for k in 0..2 {
            let x = a.surge_flow[k];
            let y = b.surge_flow[k];
            result.pressure_pair_ratio = result.pressure_pair_ratio.max(result.record(
                "surge-actual-mass-flow-kg-s",
                k,
                x,
                y,
                (x - y).abs(),
                0.005 * y.abs() + SURGE_FLOW_RESOLUTION,
            )?);
        }
        let href = model.carrier.hydrogen_per_kg();
        for (start, mass_row) in [
            (l.surge_carrier_start, ss + fs::MASS),
            (l.pool_carrier_start, ps + cp::LIQUID_MASS),
        ] {
            for species in 0..2 {
                let row = start + if species == 0 { 0 } else { 2 };
                let x = a.y[row];
                let y = b.y[row];
                let (ra, rb, dr) = if species == 0 {
                    (
                        href * a.y[mass_row] - x,
                        href * b.y[mass_row] - y,
                        href * (a.y[mass_row] - b.y[mass_row]) - (x - y),
                    )
                } else {
                    (
                        a.y[start + 1],
                        b.y[start + 1],
                        a.y[start + 1] - b.y[start + 1],
                    )
                };
                let q = self.carrier_q[species];
                let (energy, remaining) = carrier_comparison(x, y, ra, rb, dr, q)?;
                result.record_product_distribution(
                    "pressure-liquid-capture-product-energy-equivalent-distribution",
                    row,
                    q * x,
                    q * y,
                    q * (x - y).abs(),
                    energy.1,
                )?;
                result.pressure_material_pair_ratio =
                    result.pressure_material_pair_ratio.max(result.record(
                        "pressure-support-remaining-target",
                        row,
                        ra,
                        rb,
                        dr.abs(),
                        remaining.1,
                    )?);
            }
        }
        let row = l.gas_hydrogen_product;
        let x = a.y[row];
        let y = b.y[row];
        let q = self.carrier_q[0];
        let ra = href * a.y[ps + cp::VAPOR_MASS] - x;
        let rb = href * b.y[ps + cp::VAPOR_MASS] - y;
        let dr = href * (a.y[ps + cp::VAPOR_MASS] - b.y[ps + cp::VAPOR_MASS]) - (x - y);
        let (energy, remaining) = carrier_comparison(x, y, ra, rb, dr, q)?;
        result.record_product_distribution(
            "pressure-vapor-capture-product-energy-equivalent-distribution",
            row,
            q * x,
            q * y,
            q * (x - y).abs(),
            energy.1,
        )?;
        result.pressure_material_pair_ratio =
            result.pressure_material_pair_ratio.max(result.record(
                "pressure-vapor-remaining-target",
                row,
                ra,
                rb,
                dr.abs(),
                remaining.1,
            )?);
        Ok(())
    }
}
/// Sum per-owner generated increments before applying Q, with compensated
/// addition. Initial products are retained inventory, not newly paid captures.
fn mobile_generated_energy(
    model: &Model,
    species: usize,
    y: &[f64],
    initial: &[f64],
    q: f64,
) -> Result<f64, String> {
    if y.len() != model.dimension() || initial.len() != y.len() || !q.is_finite() || q < 0. {
        return Err("Invalid closed mobile product accounting shape/Q".into());
    }
    let (mut sum, mut compensation) = (0f64, 0f64);
    for row in model.mobile_product_rows(species) {
        let value = y[row] - initial[row];
        let next = sum + value;
        compensation += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    let result = q * (sum + compensation);
    if !result.is_finite() {
        return Err("Nonfinite closed mobile product accounting".into());
    }
    Ok(result)
}
fn refined(values: &[f64], refinement: f64) -> Result<Vec<f64>, String> {
    if !refinement.is_finite() || refinement <= 0. {
        return Err("Invalid cold-join tolerance refinement".into());
    }
    let result = values.iter().map(|v| v / refinement).collect::<Vec<_>>();
    if result.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid refined cold-join weights".into());
    }
    Ok(result)
}
fn barrel_details(model: &Model, s: &Sample) -> String {
    let l = model.layout;
    let p = model.barrel.config();
    let contacts = p
        .contacts
        .iter()
        .map(|c| {
            format!(
                "{{\"water\":{},\"sensibleToWaterW\":{}}}",
                c.water,
                finite(
                    p.wet_h_w_m2_k
                        * c.area_m2
                        * (s.y[l.barrel_temperature]
                            - model
                                .network
                                .temperature(c.water, &s.y[l.network_start..l.carrier_start]))
                )
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"temperatureK\":{},\"sensibleEnergyJ\":{},\"emittedEnergyJ\":{},\"exportedEnergyJ\":{},\"emittedW\":{},\"nuclearLocalW\":{},\"exportW\":{},\"waterPhotonWByNativeCell\":{},\"sensibleContacts\":[{contacts}]}}",
        finite(s.y[l.barrel_temperature]),
        finite(s.y[l.barrel_energy]),
        finite(s.y[l.barrel_released]),
        finite(s.y[l.barrel_exported]),
        finite(s.barrel_power[0]),
        finite(s.barrel_power[1]),
        finite(s.barrel_power[2]),
        super::numbers(&s.barrel_power[3..])
    )
}
fn carrier_comparison(
    x: f64,
    y: f64,
    remaining_a: f64,
    remaining_b: f64,
    remaining_difference: f64,
    q: f64,
) -> Result<((f64, f64), (f64, f64)), String> {
    if [x, y, remaining_a, remaining_b, remaining_difference, q]
        .iter()
        .any(|v| !v.is_finite())
        || remaining_a < 0.
        || remaining_b < 0.
        || q < 0.
    {
        return Err("Invalid common carrier target/product".into());
    }
    let bound = 1e-3 * (q * y).abs() + 20. * ENERGY_ATOL;
    let energy = ratio(q * (x - y).abs(), bound)?;
    let remaining_bound = 1e-3 * remaining_b.abs() + 20. * COUNT_ATOL;
    let remaining = ratio(remaining_difference.abs(), remaining_bound)?;
    Ok(((energy, bound), (remaining, remaining_bound)))
}
pub(super) fn deposit_comparison(a: &[f64], b: &[f64]) -> Result<((f64, usize), f64), String> {
    if a.len() != b.len() || a.is_empty() {
        return Err("Wrong fuel-deposition comparison shape".into());
    }
    let mut worst = (0., 0);
    let mut error = 0.;
    let mut signal = 0.;
    for (i, (&x, &y)) in a.iter().zip(b).enumerate() {
        let difference = (x - y).abs();
        let value = ratio(difference, 1e-3 * y.abs() + 20. * DEPOSIT_RESOLUTION_W)?;
        if value > worst.0 {
            worst = (value, i);
        }
        error += difference;
        signal += y.abs();
    }
    Ok((
        worst,
        ratio(
            error,
            1e-3 * signal + 20. * DEPOSIT_RESOLUTION_W * b.len() as f64,
        )?,
    ))
}
pub(super) struct Comparison {
    pub source: source_pair::PairComparison,
    pub thermal_temperature_ratio: f64,
    pub thermal_energy_ratio: f64,
    pub thermal_family_ratio: f64,
    pub network_temperature_ratio: f64,
    pub network_pressure_ratio: f64,
    pub secondary_mass_ratio: f64,
    pub sg_heat_ratio: f64,
    pub prhr_pair_ratio: f64,
    pub carrier_ratio: f64,
    pub carrier_product_distribution_ratio: f64,
    carrier_product_distribution_worst: Option<(&'static str, usize, f64, f64, f64, f64, f64)>,
    carrier_generated_totals: String,
    pub deposit_local_ratio: f64,
    pub deposit_sumabs_ratio: f64,
    pub max_temperature_change: f64,
    pub max_temperature_difference: f64,
    pub barrel_thermal_ratio: f64,
    pub barrel_power_ratio: f64,
    pub capture_power_local_ratio: f64,
    pub capture_power_sumabs_ratio: f64,
    pub capture_paid_energy_ratio: f64,
    pub mobile_power_local_ratio: f64,
    pub mobile_power_sumabs_ratio: f64,
    pub mobile_paid_energy_ratio: f64,
    mobile_details: String,
    pub pressure_pair_ratio: f64,
    pub pressure_material_pair_ratio: f64,
    pub max_pressure_change: f64,
    pub max_pressure_difference: f64,
    barrel_details: String,
    capture_details: String,
    prhr_details: String,
    worst: Option<(&'static str, usize, f64, f64, f64, f64, f64)>,
}
impl Comparison {
    pub fn mobile_receipts(&self) -> &str {
        &self.mobile_details
    }
    fn record_product_distribution(
        &mut self,
        family: &'static str,
        row: usize,
        x: f64,
        y: f64,
        difference: f64,
        bound: f64,
    ) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("Nonfinite mobile product distribution".into());
        }
        let value = ratio(difference, bound)?;
        if self
            .carrier_product_distribution_worst
            .is_none_or(|w| value > w.6)
        {
            self.carrier_product_distribution_worst =
                Some((family, row, x, y, difference, bound, value));
        }
        self.carrier_product_distribution_ratio =
            self.carrier_product_distribution_ratio.max(value);
        Ok(())
    }
    pub(super) fn record(
        &mut self,
        family: &'static str,
        row: usize,
        x: f64,
        y: f64,
        difference: f64,
        bound: f64,
    ) -> Result<f64, String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("Nonfinite cold-join paired value".into());
        }
        let value = ratio(difference, bound)?;
        if self.worst.is_none_or(|w| value > w.6) {
            self.worst = Some((family, row, x, y, difference, bound, value));
        }
        Ok(value)
    }
    pub fn failed(&self) -> bool {
        self.source.failed()
            || [
                self.thermal_temperature_ratio,
                self.thermal_energy_ratio,
                self.thermal_family_ratio,
                self.network_temperature_ratio,
                self.network_pressure_ratio,
                self.secondary_mass_ratio,
                self.sg_heat_ratio,
                self.prhr_pair_ratio,
                self.carrier_ratio,
                self.deposit_local_ratio,
                self.deposit_sumabs_ratio,
                self.barrel_thermal_ratio,
                self.barrel_power_ratio,
                self.capture_power_local_ratio,
                self.capture_power_sumabs_ratio,
                self.capture_paid_energy_ratio,
                self.mobile_power_local_ratio,
                self.mobile_power_sumabs_ratio,
                self.mobile_paid_energy_ratio,
                self.pressure_pair_ratio,
                self.pressure_material_pair_ratio,
            ]
            .iter()
            .any(|v| *v > 1.)
    }
    pub fn json(&self) -> String {
        let worst=self.worst.map_or("null".into(),|(family,row,a,b,difference,bound,value)|format!("{{\"family\":{},\"row\":{row},\"normal\":{},\"tighter\":{},\"difference\":{},\"bound\":{},\"ratio\":{}}}",quote(family),finite(a),finite(b),finite(difference),finite(bound),finite(value)));
        let prhr_ratio = finite(self.prhr_pair_ratio);
        let prhr_details = &self.prhr_details;
        let generated_totals = &self.carrier_generated_totals;
        let mobile = format!("\"mobileCapturePowerLocalRatio\":{},\"mobileCapturePowerSUMABSRatio\":{},\"mobileCapturePaidEnergyRatio\":{},\"mobileCaptureReceipts\":{}",finite(self.mobile_power_local_ratio),finite(self.mobile_power_sumabs_ratio),finite(self.mobile_paid_energy_ratio),self.mobile_details);
        let product_distribution = self.carrier_product_distribution_worst.map_or("null".into(), |(family,row,a,b,difference,bound,value)| format!("{{\"admission\":false,\"family\":{},\"row\":{row},\"normal\":{},\"tighter\":{},\"difference\":{},\"bound\":{},\"ratio\":{}}}",quote(family),finite(a),finite(b),finite(difference),finite(bound),finite(value)));
        format!(
            "{{{mobile},\"policy\":\"{POLICY}\",\"provisional\":true,\"fullPairQualified\":false,\"prhrPairRatio\":{prhr_ratio},\"prhrReceipts\":{prhr_details},\"source\":{},\"thermalTemperatureRatio\":{},\"thermalEnergyRatio\":{},\"thermalSUMABSRatio\":{},\"networkTemperatureRatio\":{},\"networkPressureRatio\":{},\"secondaryMassRatio\":{},\"SGHeatRatio\":{},\"carrierConsequenceRatio\":{},\"carrierComparisonPolicy\":\"{CARRIER_POLICY}\",\"carrierGeneratedTotals\":{generated_totals},\"carrierProductDistributionDiagnostic\":{product_distribution},\"depositionLocalRatio\":{},\"depositionSUMABSRatio\":{},\"thermalTemperatureChange\":{},\"thermalTemperaturePairDifference\":{},\"barrelPairRatio\":{},\"barrelPowerPairRatio\":{},\"barrelReceipts\":{},\"capturePowerLocalRatio\":{},\"capturePowerSUMABSRatio\":{},\"capturePaidEnergyRatio\":{},\"captureReceipts\":{},\"pressurePairRatio\":{},\"pressureMaterialPairRatio\":{},\"pressureChangePa\":{},\"pressurePairDifferencePa\":{},\"worstCooling\":{}}}",
            self.source.json(),
            finite(self.thermal_temperature_ratio),
            finite(self.thermal_energy_ratio),
            finite(self.thermal_family_ratio),
            finite(self.network_temperature_ratio),
            finite(self.network_pressure_ratio),
            finite(self.secondary_mass_ratio),
            finite(self.sg_heat_ratio),
            finite(self.carrier_ratio),
            finite(self.deposit_local_ratio),
            finite(self.deposit_sumabs_ratio),
            finite(self.max_temperature_change),
            finite(self.max_temperature_difference),
            finite(self.barrel_thermal_ratio),
            finite(self.barrel_power_ratio),
            self.barrel_details,
            finite(self.capture_power_local_ratio),
            finite(self.capture_power_sumabs_ratio),
            finite(self.capture_paid_energy_ratio),
            self.capture_details,
            finite(self.pressure_pair_ratio),
            finite(self.pressure_material_pair_ratio),
            finite(self.max_pressure_change),
            finite(self.max_pressure_difference),
            worst
        )
    }
}
pub(super) fn check_schedule(samples: &[Sample]) -> Result<(), String> {
    if samples.len() != OUTPUTS.len() || samples.iter().zip(OUTPUTS).any(|(s, t)| s.time != t) {
        return Err("Missing/truncated cold-join common output schedule".into());
    }
    Ok(())
}
pub(super) fn captured_targets(model: &Model, y: &[f64]) -> Result<Vec<f64>, String> {
    if y.len() != model.dimension() {
        return Err("Wrong source capture sample shape".into());
    }
    (0..model.source.target_reference_atoms().len())
        .map(|i| {
            model
                .source
                .consumed_target(&y[..model.layout.source_end], i)
                .map_err(str::to_owned)
        })
        .collect()
}
pub(super) fn barrel_powers(
    w: &leitbild_plant_numerics::source_cooling::Workspace,
) -> Result<Vec<f64>, String> {
    let mut powers = vec![
        w.barrel.emitted_rate()?,
        w.barrel.nuclear_heat_rate()?,
        w.barrel.export_rate()?,
    ];
    powers.extend_from_slice(w.barrel.water_photon_heat()?);
    Ok(powers)
}
pub(super) fn nc_coefficients(model: &Model, work: &SourceWorkspace) -> Result<Vec<f64>, String> {
    let mut out = vec![0.; model.source.nc_pattern().len()];
    model.source.nc_values(work, 0., &mut out)?;
    if out.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite current source NC coefficients".into());
    }
    Ok(out)
}
pub(super) struct SourceAdmission {
    pub rhs_number_defect: f64,
    pub number_defect: f64,
    pub energy_defect: f64,
    pub cf_error: f64,
}
/// Same prior source accepted-state numerical screens. External carrier and
/// thermal/chart admission remain separate mandatory owners, not omitted here.
pub(super) fn admit_source(
    model: &Model,
    y: &[f64],
    work: &SourceWorkspace,
    time: f64,
) -> Result<SourceAdmission, String> {
    if y.len() != model.dimension() {
        return Err("Wrong source admission state shape".into());
    }
    let m = &model.source;
    let y = &y[..model.layout.source_end];
    m.validate_accepted_state(y)?;
    let d = work.diagnostics()?;
    let rates = work.rates()?;
    if [
        d.neutrons,
        d.precursors,
        d.retained_energy_j,
        d.fission_events_s,
        d.induced_fission_events_s,
        d.net_neutron_events_s,
        d.neutron_event_scale_s,
        d.escape_neutrons_s,
        d.collected_events_s,
        d.capture_events_s,
        d.cf_births_s,
        d.cf_release_w,
        d.cf_export_w,
        d.fuel_release_w,
        d.mn_electron_release_w,
        d.mn_photon_release_w,
    ]
    .iter()
    .any(|v| !v.is_finite())
        || !time.is_finite()
        || time < 0.
    {
        return Err("Nonfinite source admission diagnostic/time".into());
    }
    let rhs = (rates[..m.nc_dimension()].iter().sum::<f64>() - d.net_neutron_events_s).abs();
    let balance = m.conservation(y)?;
    let expected_cf = -m.prepared_cf_energy() * (-m.cf_decay_rate() * time).exp_m1();
    let cf = (y[m.cf_row()] - expected_cf).abs();
    if [
        rhs,
        d.neutron_event_scale_s,
        balance.neutron_ledger_defect.abs(),
        balance.neutron_ledger_scale,
        balance.energy_ledger_defect_j.abs(),
        balance.energy_ledger_scale_j,
        expected_cf,
        cf,
    ]
    .iter()
    .any(|v| !v.is_finite() || *v < 0.)
    {
        return Err("Invalid source ledger/Cf operand".into());
    }
    if rhs > 1e-10 * d.neutron_event_scale_s.max(1e-30)
        || balance.neutron_ledger_defect.abs()
            > 1e-8 * balance.neutron_ledger_scale + 10. * COUNT_ATOL * m.nc_dimension() as f64
        || balance.energy_ledger_defect_j.abs()
            > 1e-8 * balance.energy_ledger_scale_j
                + 10. * ENERGY_ATOL * m.energy_rows().count() as f64
        || cf > 1e-3 * expected_cf.abs() + 20. * ENERGY_ATOL
    {
        return Err(format!(
            "Independent source ledger/Cf refused: RHS={rhs:e}, number={:e}, energy={:e}, Cf={cf:e}",
            balance.neutron_ledger_defect, balance.energy_ledger_defect_j
        ));
    }
    Ok(SourceAdmission {
        rhs_number_defect: rhs,
        number_defect: balance.neutron_ledger_defect.abs(),
        energy_defect: balance.energy_ledger_defect_j.abs(),
        cf_error: cf,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(model: &Model) -> Sample {
        let y = model.initial_state().unwrap();
        let mut w = model.workspace();
        model
            .evaluate(&y, &vec![0.; y.len()], None, &mut w)
            .unwrap();
        Sample {
            time: 0.001,
            source_d: w.source.diagnostics().unwrap(),
            source_captures: captured_targets(model, &y).unwrap(),
            source_nc: nc_coefficients(model, &w.source).unwrap(),
            deposition: w.source.fuel_deposition().unwrap().to_vec(),
            water_mass: w.network.chart_mass.clone(),
            barrel_power: barrel_powers(&w).unwrap(),
            capture_power: w.capture.power_channels().unwrap().to_vec(),
            mobile_power: w.mobile_capture.value().unwrap().channels.clone(),
            bundle_power: super::super::cooling_bundle::powers(&w),
            mobile_recipient_power: w
                .mobile_capture
                .value()
                .unwrap()
                .recipient_power()
                .collect(),
            surge_flow: {
                let q = w.surge.receipts().unwrap().mass;
                [q[0], -q[1]]
            },
            y,
        }
    }
    #[test]
    fn mobile_birth_recipients_and_exclusive_exports_cannot_hide_wrong_zero_or_cancel() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let emissions = vec![[0.01, 0.02]; model.source.target_reference_atoms().len()];
        let accuracy = Accuracy::new(&model, &emissions, None).unwrap();
        let a = sample(&model);
        assert!(!accuracy.compare_one(&model, &a, &a).unwrap().failed());
        for channel in 0..12 {
            let mut b = sample(&model);
            b.mobile_power[channel] += 1e-6;
            let c = accuracy.compare_one(&model, &a, &b).unwrap();
            assert!(c.mobile_power_local_ratio > 1. && c.failed());
        }
        for recipient in [0, model.carrier.cells(), a.mobile_recipient_power.len() - 1] {
            let mut b = sample(&model);
            b.mobile_recipient_power[recipient] += 1e-6;
            let c = accuracy.compare_one(&model, &a, &b).unwrap();
            assert!(c.mobile_power_local_ratio > 1. && c.failed());
        }
        for row in [
            model.layout.mobile_capture_exported,
            model.layout.mobile_capture_boundary_exported,
        ] {
            let mut b = sample(&model);
            b.y[row] += 1e-9;
            let c = accuracy.compare_one(&model, &a, &b).unwrap();
            assert!(c.mobile_paid_energy_ratio > 1. && c.failed());
            assert_eq!(
                accuracy.absolute(1.).unwrap()[row] / 10.,
                accuracy.absolute(10.).unwrap()[row]
            );
        }
        // Equal-and-opposite species paid energy is not one cancelling budget.
        let q = model.mobile_capture.paid_energy();
        let mut b = sample(&model);
        b.y[model.mobile_product_rows(0).next().unwrap()] += 1e-9 / q[0];
        b.y[model.mobile_product_rows(1).next().unwrap()] -= 1e-9 / q[1];
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .mobile_paid_energy_ratio
                > 1.
        );
        let mut malformed = sample(&model);
        malformed.mobile_power.pop();
        assert!(accuracy.compare_one(&model, &a, &malformed).is_err());
        malformed = sample(&model);
        malformed.mobile_recipient_power.pop();
        assert!(accuracy.compare_one(&model, &a, &malformed).is_err());
        // The network receives paid heat less BOTH exclusive exports, once.
        let mut y = model.initial_state().unwrap();
        let original = accuracy.expected_network_totals(&model, &y).unwrap()[1];
        y[model.mobile_product_rows(0).next().unwrap()] += 4. / q[0];
        y[model.layout.mobile_capture_exported] += 1.;
        y[model.layout.mobile_capture_boundary_exported] += 0.5;
        assert!(
            (accuracy.expected_network_totals(&model, &y).unwrap()[1] - original - 2.5).abs()
                < 1e-6
        );
    }
    #[test]
    fn mobile_products_compare_closed_generation_not_local_heat_redistribution() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let accuracy = Accuracy::new(
            &model,
            &vec![[0.01, 0.02]; model.source.target_reference_atoms().len()],
            None,
        )
        .unwrap();
        let l = model.layout;
        let mut a = sample(&model);
        let mut b = sample(&model);
        let q = accuracy.carrier_q[1];
        assert!(q > 0.);
        // A transported stable product does not deposit its binding Q again.
        a.y[l.carrier_start + 2] += 1e-7 / q;
        b.y[l.pool_carrier_start + 2] += 1e-7 / q;
        let comparison = accuracy.compare_one(&model, &a, &b).unwrap();
        assert!(comparison.carrier_product_distribution_ratio > 1.);
        assert_eq!(comparison.carrier_ratio, 0.);
        assert!(!comparison.failed());
        // Omitting the receiving compartment or accepting a wrong-zero total
        // would hide this mismatch; the complete generated-total gate refuses.
        b.y[l.pool_carrier_start + 2] = accuracy.initial[l.pool_carrier_start + 2];
        let comparison = accuracy.compare_one(&model, &a, &b).unwrap();
        assert!(comparison.carrier_ratio > 1. && comparison.failed());
        // H/B have separate budgets, not a cancelling combined-energy sum.
        b.y[l.gas_hydrogen_product] += 1e-7 / accuracy.carrier_q[0];
        assert!(accuracy.compare_one(&model, &a, &b).unwrap().carrier_ratio > 1.);
        // Remaining B10 is a current source consumer and remains a local gate.
        a = sample(&model);
        b = sample(&model);
        b.y[l.carrier_start + 1] *= 1.01;
        assert!(accuracy.compare_one(&model, &a, &b).unwrap().carrier_ratio > 1.);
    }
    #[test]
    fn generated_mobile_product_sums_use_every_owner_and_prepared_offsets() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        for species in 0..2 {
            let mut initial = model.initial_state().unwrap();
            let mut y = initial.clone();
            let rows = model.mobile_product_rows(species).collect::<Vec<_>>();
            for (i, &row) in rows.iter().enumerate() {
                initial[row] = 1000. + i as f64;
                y[row] = initial[row] + 0.125;
            }
            assert_eq!(
                mobile_generated_energy(&model, species, &initial, &initial, 0.5).unwrap(),
                0.
            );
            assert_eq!(
                mobile_generated_energy(&model, species, &y, &initial, 0.5).unwrap(),
                rows.len() as f64 * 0.0625
            );
            for &row in &rows {
                y[row] += 0.25;
                assert_eq!(
                    mobile_generated_energy(&model, species, &y, &initial, 0.5).unwrap(),
                    rows.len() as f64 * 0.0625 + 0.125
                );
                y[row] -= 0.25;
            }
        }
    }
    #[test]
    fn barrel_owned_energy_expectation_and_nuclear_pair_cannot_hide_in_thermal_power() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let emissions = vec![[0.01, 0.02]; model.source.target_reference_atoms().len()];
        let accuracy = Accuracy::new(&model, &emissions, None).unwrap();
        let l = model.layout;
        let mut y = model.initial_state().unwrap();
        let original = accuracy.expected_network_totals(&model, &y).unwrap();
        y[l.barrel_energy] += 2.;
        y[l.barrel_released] += 4.;
        y[l.barrel_exported] += 1.;
        let expected = accuracy.expected_network_totals(&model, &y).unwrap();
        assert!((expected[1] - original[1] - 1.).abs() < 1e-6);
        let a = sample(&model);
        let mut b = sample(&model);
        assert!(!accuracy.compare_one(&model, &a, &b).unwrap().failed());
        b.barrel_power[1] = 1e-6;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .barrel_power_ratio
                > 1.
        );
        b = sample(&model);
        b.barrel_power[3] = 1e-6;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .barrel_power_ratio
                > 1.
        );
        b = sample(&model);
        b.y[l.barrel_released] = 1e-9;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .barrel_thermal_ratio
                > 1.
        );
        let normal = accuracy.absolute(1.).unwrap();
        let tight = accuracy.absolute(10.).unwrap();
        for row in [
            l.barrel_energy,
            l.barrel_temperature,
            l.barrel_released,
            l.barrel_exported,
        ] {
            assert_eq!(normal[row] / 10., tight[row]);
        }
    }
    #[test]
    fn binding_channels_and_paid_exported_energy_are_independently_qualified() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let emissions = vec![[0.01, 0.02]; model.source.target_reference_atoms().len()];
        let accuracy = Accuracy::new(&model, &emissions, None).unwrap();
        let a = sample(&model);
        assert!(!accuracy.compare_one(&model, &a, &a).unwrap().failed());
        for channel in 0..5 {
            let mut b = sample(&model);
            b.capture_power[channel] += 1e-6;
            let c = accuracy.compare_one(&model, &a, &b).unwrap();
            assert!(c.capture_power_local_ratio > 1. && c.failed());
        }
        let mut b = sample(&model);
        b.capture_power.pop();
        assert!(accuracy.compare_one(&model, &a, &b).is_err());
        let mut b = sample(&model);
        b.y[model.layout.fuel_capture_exported] += 1e-9;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .capture_paid_energy_ratio
                > 1.
        );
        let mut b = sample(&model);
        let (row, q) = model.capture_paid_rows().next().unwrap();
        b.y[row] += 1e-9 / q;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .capture_paid_energy_ratio
                > 1.
        );
        let normal = accuracy.absolute(1.).unwrap();
        let tight = accuracy.absolute(10.).unwrap();
        assert_eq!(
            normal[model.layout.fuel_capture_exported] / 10.,
            tight[model.layout.fuel_capture_exported]
        );
        let mut y = model.initial_state().unwrap();
        let original = accuracy.expected_network_totals(&model, &y).unwrap();
        y[row] += 4. / q;
        y[model.layout.fuel_capture_exported] += 1.;
        let expected = accuracy.expected_network_totals(&model, &y).unwrap();
        assert!((expected[1] - original[1] - 3.).abs() < 1e-6);
    }
    #[test]
    fn all_absolute_weights_refine_and_refuse_invalid_values() {
        assert_eq!(refined(&[2., 3.], 10.).unwrap(), vec![0.2, 0.3]);
        assert!(refined(&[1.], 0.).is_err());
        assert!(refined(&[f64::NAN], 1.).is_err());
        assert!(refined(&[f64::from_bits(1)], 10.).is_err());
    }
    #[test]
    fn pressure_support_is_in_closed_ledgers_and_refined_comparison() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let emissions = vec![[0.01, 0.02]; model.source.target_reference_atoms().len()];
        let accuracy = Accuracy::new(&model, &emissions, None).unwrap();
        let l = model.layout;
        let normal = accuracy.absolute(1.).unwrap();
        let tight = accuracy.absolute(10.).unwrap();
        for row in l.pressurizer_start..model.dimension() {
            assert!(normal[row].is_finite() && normal[row] > 0.);
            assert_eq!(normal[row] / 10., tight[row]);
        }
        let a = sample(&model);
        let mut b = sample(&model);
        assert!(!accuracy.compare_one(&model, &a, &b).unwrap().failed());
        b.y[l.pressurizer_start + cp::SURFACE_PRESSURE] += 10.;
        assert!(
            accuracy
                .compare_one(&model, &a, &b)
                .unwrap()
                .pressure_pair_ratio
                > 1.
        );
        let mut y = model.initial_state().unwrap();
        let original = accuracy.expected_network_totals(&model, &y).unwrap();
        y[l.surge_start + fs::MASS] += 0.25;
        y[l.pressurizer_start + cp::LIQUID_MASS] += 0.5;
        y[l.pressurizer_start + cp::VAPOR_MASS] += 0.125;
        y[l.pressurizer_start + cp::LIQUID_ENERGY] += 2.;
        y[l.surge_start + fs::STEEL_ENERGY] += 3.;
        y[l.ambient_exported] += 4.;
        let changed = accuracy.expected_network_totals(&model, &y).unwrap();
        assert!((changed[0] - original[0] + 0.875).abs() < 1e-6);
        assert!((changed[1] - original[1] + 9.).abs() < 1e-6);
        // A line/pool leak cannot disappear from the closed B ledger merely
        // because every primary carrier still matches its initial value.
        y[l.pool_carrier_start + 1] += accuracy.carrier_atoms_per_marker * 1e-6;
        assert!(accuracy.carrier_ledger(&model, &y).is_err());
        assert!(check_pressure_chart(&model, &[0.; 7], &[0.; 2], 1e4).is_ok());
        let mut chart = [0.; 7];
        chart[2] = 1.1;
        assert!(check_pressure_chart(&model, &chart, &[0.; 2], 1e4).is_err());
        chart[2] = f64::NAN;
        assert!(pressure_chart_ratio(&chart, &[0.; 2], 1e4).is_err());
        // P/T and global stocks can all be correct while H alone is wrong.
        // Its hydrostatic equivalent must not disappear from the chart gate.
        let mut chart = [0.; 7];
        chart[4] = 0.001;
        assert!(pressure_chart_ratio(&chart, &[0.; 2], 1e4).unwrap() > 1.);
    }
    #[test]
    fn deposition_redistribution_cannot_cancel_or_hide_in_sg_heat() {
        let (local, sum) = deposit_comparison(&[0.01, 0.03], &[0.02, 0.02]).unwrap();
        assert!(local.0 > 1. && sum > 1.);
        assert!(deposit_comparison(&[f64::NAN], &[0.]).is_err());
        assert!(deposit_comparison(&[], &[]).is_err());
    }
    #[test]
    fn product_distribution_diagnostic_keeps_actual_remaining_target_checks() {
        let (energy, remaining) = carrier_comparison(1., 2., 99., 98., 1., 1.).unwrap();
        assert!(energy.0 > 1.);
        assert!(remaining.0 > 1.);
        assert!(carrier_comparison(1., 1., 0., 0., 0., 1.).is_ok());
        assert!(carrier_comparison(11., 1., -1., 10., 0., 1.).is_err());
        // Direct remaining inventory survives next to an enormous product;
        // (remaining+product)-product would erase both 1 and 2 here.
        let (_, r) = carrier_comparison(1e30, 1e30, 1., 2., -1., 0.).unwrap();
        assert_eq!(r.1, 0.002 + 20. * COUNT_ATOL);
        assert_eq!(r.0, 1. / r.1);
        // A changed total must be seen even with identical product counts.
        assert!(
            carrier_comparison(1., 1., 100., 200., -100., 0.)
                .unwrap()
                .1
                 .0
                > 1.
        );
        assert!(product_resolution(1., f64::INFINITY).is_err());
        assert_eq!(product_resolution(0., 1.).unwrap(), COUNT_ATOL);
        assert_eq!(product_resolution(100., 0.).unwrap(), 0.005);
    }
    #[test]
    fn full_comparison_requires_the_exact_common_schedule() {
        let mut samples = OUTPUTS
            .iter()
            .map(|&time| Sample {
                time,
                y: vec![],
                source_d: Diagnostics::default(),
                source_captures: vec![],
                source_nc: vec![],
                deposition: vec![],
                water_mass: vec![],
                barrel_power: vec![],
                capture_power: vec![],
                mobile_power: vec![],
                mobile_recipient_power: vec![],
                bundle_power: vec![],
                surge_flow: [0.; 2],
            })
            .collect::<Vec<_>>();
        assert!(check_schedule(&samples).is_ok());
        samples[2].time = 0.11;
        assert!(check_schedule(&samples).is_err());
        samples[2].time = OUTPUTS[2];
        samples.pop();
        assert!(check_schedule(&samples).is_err());
    }
}

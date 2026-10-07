//! Fixed provisional cold-join qualification, not a plant safety or empirical
//! error certificate. Reuses the SAME source-consequences-1 comparison. Local
//! deposited powers are compared separately from SG-scale thermal redistribution.
use super::{finite, quote, ratio, source_accuracy, source_pair, COUNT_ATOL, ENERGY_ATOL};
use leitbild_plant_numerics::{
    operating_admission,
    source_cooling::Model,
    source_evolution::{Diagnostics, Workspace as SourceWorkspace},
};

pub(super) const POLICY: &str = "cold-source-cooling-5";
pub(super) const OUTPUTS: [f64; 14] = [
    0.001, 0.01, 0.1, 1., 2., 5., 10., 20., 30., 60., 120., 180., 240., 300.,
];
pub(super) const TEMPERATURE_ATOL: f64 = 1e-3;
const TEMPERATURE_PAIR: f64 = 0.01;
pub(super) const DEPOSIT_RESOLUTION_W: f64 = 1e-12;

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
    barrel_capacity: f64,
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
    pub fn new(model: &Model, emissions: &[[f64; 2]]) -> Result<Self, String> {
        let initial = model.initial_state()?;
        let mut work = model.workspace();
        model.evaluate(&initial, &vec![0.; model.dimension()], None, &mut work)?;
        let source = source_accuracy::Accuracy::new(&model.source, emissions)?;
        let network = operating_admission::weights(
            &model.network,
            &work.network,
            &initial[model.layout.network_start..model.layout.products_start],
            300.,
            1.,
        )?;
        let l = model.layout;
        let mut absolute = vec![0.; model.dimension()];
        absolute[..l.source_end].copy_from_slice(&source.absolute(1.)?);
        absolute[l.network_start..l.products_start].copy_from_slice(&network.absolute);
        let law = model.source.moderator_law();
        let carrier_q = [
            law.hydrogen_emission.iter().sum(),
            law.boron_emission.iter().sum(),
        ];
        let perkg = model.carrier.reference_per_kg();
        for (i, &mass) in work.network.chart_mass.iter().enumerate() {
            for species in 0..2 {
                absolute[l.products_start + 2 * i + species] =
                    product_resolution(perkg[species] * mass, carrier_q[species])?;
            }
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
        let initial_network_totals =
            operating_admission::totals(n, &initial[l.network_start..l.products_start]);
        Ok(Self {
            source,
            normal_absolute: absolute,
            flow_absolute: network.flow,
            initial,
            initial_network_totals,
            thermal_capacity,
            energy_rows,
            carrier_q,
            barrel_capacity,
        })
    }
    pub fn absolute(&self, refinement: f64) -> Result<Vec<f64>, String> {
        refined(&self.normal_absolute, refinement)
    }
    pub fn flow_absolute(&self, refinement: f64) -> Result<Vec<f64>, String> {
        refined(&self.flow_absolute, refinement)
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
        totals[1] += released + barrel_paid
            - solid_change
            - (y[l.barrel_energy] - self.initial[l.barrel_energy]);
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
            carrier_ratio: 0.,
            deposit_local_ratio: 0.,
            deposit_sumabs_ratio: 0.,
            max_temperature_change: 0.,
            max_temperature_difference: 0.,
            barrel_thermal_ratio: 0.,
            barrel_power_ratio: 0.,
            barrel_details: String::new(),
            worst: None,
        };
        let l = model.layout;
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
        let an = &a.y[l.network_start..l.products_start];
        let bn = &b.y[l.network_start..l.products_start];
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
        // Exact existing SG recipient SUMABS criterion; unlike recipients
        // cannot cancel, and the 1 J signal floor is not an added error floor.
        result.sg_heat_ratio = ratio(sg_error, 0.005 * sg_signal.max(1.))?;
        let perkg = model.carrier.reference_per_kg();
        for i in 0..nw {
            for species in 0..2 {
                let row = l.products_start + 2 * i + species;
                let x = a.y[row];
                let y = b.y[row];
                let q = self.carrier_q[species];
                let total_a = perkg[species] * a.water_mass[i];
                let total_b = perkg[species] * b.water_mass[i];
                let total_difference = perkg[species] * (a.water_mass[i] - b.water_mass[i]);
                let (energy, remaining) =
                    carrier_comparison(x, y, total_a, total_b, total_difference, q)?;
                result.carrier_ratio = result.carrier_ratio.max(result.record(
                    "mobile-product-paid-energy-equivalent",
                    row,
                    q * x,
                    q * y,
                    q * (x - y).abs(),
                    energy.1,
                )?);
                result.carrier_ratio = result.carrier_ratio.max(result.record(
                    "mobile-remaining-target",
                    row,
                    total_a - x,
                    total_b - y,
                    (total_difference - (x - y)).abs(),
                    remaining.1,
                )?);
            }
        }
        if a.deposition.len() != model.fuel_rows().len()
            || b.deposition.len() != model.fuel_rows().len()
        {
            return Err("Wrong actual fuel-deposition dimension".into());
        }
        let (local, sumabs) = deposit_comparison(&a.deposition, &b.deposition)?;
        result.deposit_local_ratio = local.0;
        result.deposit_sumabs_ratio = sumabs;
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
                                .temperature(c.water, &s.y[l.network_start..l.products_start]))
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
    total_a: f64,
    total_b: f64,
    total_difference: f64,
    q: f64,
) -> Result<((f64, f64), (f64, f64)), String> {
    if [x, y, total_a, total_b, total_difference, q]
        .iter()
        .any(|v| !v.is_finite())
        || total_a < 0.
        || total_b < 0.
        || q < 0.
        || x > total_a
        || y > total_b
    {
        return Err("Invalid common carrier target/product".into());
    }
    if (total_a == 0. && x != 0.) || (total_b == 0. && y != 0.) {
        return Err("Nonzero structural-empty carrier product".into());
    }
    let bound = 1e-3 * (q * y).abs() + 20. * ENERGY_ATOL;
    let energy = ratio(q * (x - y).abs(), bound)?;
    let remaining_bound = 1e-3 * (total_b - y).abs() + 20. * COUNT_ATOL;
    let remaining = ratio((total_difference - (x - y)).abs(), remaining_bound)?;
    Ok(((energy, bound), (remaining, remaining_bound)))
}
fn deposit_comparison(a: &[f64], b: &[f64]) -> Result<((f64, usize), f64), String> {
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
    pub carrier_ratio: f64,
    pub deposit_local_ratio: f64,
    pub deposit_sumabs_ratio: f64,
    pub max_temperature_change: f64,
    pub max_temperature_difference: f64,
    pub barrel_thermal_ratio: f64,
    pub barrel_power_ratio: f64,
    barrel_details: String,
    worst: Option<(&'static str, usize, f64, f64, f64, f64, f64)>,
}
impl Comparison {
    fn record(
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
                self.carrier_ratio,
                self.deposit_local_ratio,
                self.deposit_sumabs_ratio,
                self.barrel_thermal_ratio,
                self.barrel_power_ratio,
            ]
            .iter()
            .any(|v| *v > 1.)
    }
    pub fn json(&self) -> String {
        let worst=self.worst.map_or("null".into(),|(family,row,a,b,difference,bound,value)|format!("{{\"family\":{},\"row\":{row},\"normal\":{},\"tighter\":{},\"difference\":{},\"bound\":{},\"ratio\":{}}}",quote(family),finite(a),finite(b),finite(difference),finite(bound),finite(value)));
        format!(
            "{{\"policy\":\"cold-source-cooling-5\",\"provisional\":true,\"fullPairQualified\":false,\"source\":{},\"thermalTemperatureRatio\":{},\"thermalEnergyRatio\":{},\"thermalSUMABSRatio\":{},\"networkTemperatureRatio\":{},\"networkPressureRatio\":{},\"secondaryMassRatio\":{},\"SGHeatRatio\":{},\"carrierConsequenceRatio\":{},\"depositionLocalRatio\":{},\"depositionSUMABSRatio\":{},\"thermalTemperatureChange\":{},\"thermalTemperaturePairDifference\":{},\"barrelPairRatio\":{},\"barrelPowerPairRatio\":{},\"barrelReceipts\":{},\"worstCooling\":{}}}",
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
            y,
        }
    }
    #[test]
    fn barrel_owned_energy_expectation_and_nuclear_pair_cannot_hide_in_thermal_power() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let emissions = vec![[0.01, 0.02]; model.source.target_reference_atoms().len()];
        let accuracy = Accuracy::new(&model, &emissions).unwrap();
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
    fn all_absolute_weights_refine_and_refuse_invalid_values() {
        assert_eq!(refined(&[2., 3.], 10.).unwrap(), vec![0.2, 0.3]);
        assert!(refined(&[1.], 0.).is_err());
        assert!(refined(&[f64::NAN], 1.).is_err());
        assert!(refined(&[f64::from_bits(1)], 10.).is_err());
    }
    #[test]
    fn deposition_redistribution_cannot_cancel_or_hide_in_sg_heat() {
        let (local, sum) = deposit_comparison(&[0.01, 0.03], &[0.02, 0.02]).unwrap();
        assert!(local.0 > 1. && sum > 1.);
        assert!(deposit_comparison(&[f64::NAN], &[0.]).is_err());
        assert!(deposit_comparison(&[], &[]).is_err());
    }
    #[test]
    fn mobile_products_have_paid_energy_and_actual_remaining_target_checks() {
        let (energy, remaining) = carrier_comparison(1., 2., 100., 100., 0., 1.).unwrap();
        assert!(energy.0 > 1.);
        assert!(remaining.0 > 1.);
        assert!(carrier_comparison(1., 1., 0., 0., 0., 1.).is_err());
        assert!(carrier_comparison(11., 1., 10., 10., 0., 1.).is_err());
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

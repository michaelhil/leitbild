//! Read-only consequence of the one bank-wide signed fluid-work receipt.
//! Existing fixed-current caloric charts are linearized, not reinitialized or
//! advanced. This is a local sensitivity, never a trajectory error theorem.
use leitbild_plant_numerics::{operating_admission, source_motion as sm};

// Reuse the current network chart-coherence selections, not plant limits.
// Applying them to this local sensitivity is a conservative comparison, not
// an inherited trajectory-error guarantee.
const PRESSURE_COMPARISON_PA: f64 = operating_admission::CHART_PRESSURE_LIMIT_PA;
const CALORIC_COMPARISON_K: f64 = operating_admission::CHART_TEMPERATURE_LIMIT_K;

struct Response {
    pressure: f64,
    temperatures: Vec<f64>,
}

/// All other energy stocks and total primary mass are held fixed. From
/// dE_i=Ep_i*dP+ET_i*dT_i and sum(dM_i)=0, eliminate every dT_i.
fn response(chart: &[[f64; 4]], receiver: usize, energy: f64) -> Result<(f64, Response), String> {
    if receiver >= chart.len() || !energy.is_finite()
        || chart.iter().any(|p| p.iter().any(|v| !v.is_finite()) || p[3] <= 0.)
    {
        return Err("Invalid current bank-work caloric chart".into());
    }
    let compliance = chart.iter().map(|[mp, mt, ep, et]| mp - mt * ep / et).sum::<f64>();
    if !compliance.is_finite() || compliance <= 0. {
        return Err("Nonpositive current primary fixed-energy mass compliance".into());
    }
    let pressure = -(chart[receiver][1] / chart[receiver][3]) * energy / compliance;
    let temperatures = chart.iter().enumerate().map(|(i, p)| {
        ((if i == receiver { energy } else { 0. }) - p[2] * pressure) / p[3]
    }).collect::<Vec<_>>();
    if !pressure.is_finite() || temperatures.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite current bank-work sensitivity".into());
    }
    Ok((compliance, Response { pressure, temperatures }))
}

/// The installed solid's authored energy law is E=C*(T-SOLID_DATUM_K).
fn solid_response(capacity: f64, energy: f64) -> Result<Response, String> {
    if !capacity.is_finite() || capacity <= 0. || !energy.is_finite() {
        return Err("Invalid bank-work solid caloric chart".into());
    }
    let temperature = energy / capacity;
    if !temperature.is_finite() {
        return Err("Nonfinite bank-work solid sensitivity".into());
    }
    Ok(Response { pressure: 0., temperatures: vec![temperature] })
}

/// Existing wet-secondary chart order is [U_T,U_p,G_T,G_p]. At unchanged
/// species inventories and G=0: dT=dU/(U_T-U_p*G_T/G_p), dp=-G_T*dT/G_p.
fn secondary_response(a: [f64; 4], energy: f64) -> Result<(f64, Response), String> {
    if a.iter().any(|v| !v.is_finite()) || a[3] <= 0. || !energy.is_finite() {
        return Err("Invalid bank-work wet-secondary chart".into());
    }
    let capacity = a[0] - a[1] * a[2] / a[3];
    if !capacity.is_finite() || capacity <= 0. {
        return Err("Nonpositive bank-work wet-secondary equilibrium heat capacity".into());
    }
    let temperature = energy / capacity;
    let pressure = -a[2] * temperature / a[3];
    if !temperature.is_finite() || !pressure.is_finite() {
        return Err("Nonfinite bank-work wet-secondary sensitivity".into());
    }
    Ok((capacity, Response { pressure, temperatures: vec![temperature] }))
}

fn receiver_json(model: &sm::Model, work: &sm::Workspace, receiver: usize,
    positive_work_error_j: f64) -> Result<(String, Response), String>
{
    let network = &model.cooling.network;
    let w = &work.cooling.network;
    // Positive W is water -> mechanics. At a fixed thermal balance coordinate
    // its error decodes to negative water energy, not an additional heater.
    let (compliance, r) = response(&w.chart_derivatives, receiver, -positive_work_error_j)?;
    let maximum = r.temperatures.iter().enumerate()
        .max_by(|(_, a), (_, b)| a.abs().total_cmp(&b.abs()))
        .ok_or("Empty bank-work temperature response")?;
    let json = format!(concat!(
        "{{\"owner\":\"primary-water\",\"waterIndex\":{},\"energyRow\":{},\"currentMassKg\":{},",
        "\"currentChartDerivativesMpMtEpEt\":[{},{},{},{}],\"derivativeUnits\":\"kg/Pa,kg/K,J/Pa,J/K\",",
        "\"fixedPressureEnergyCapacityJPerK\":{},\"fixedEnergyMassComplianceKgPerPa\":{},",
        "\"positiveWorkErrorJ\":{},\"waterEnergyErrorJ\":{},\"pressureErrorPa\":{},",
        "\"receiverTemperatureErrorK\":{},\"maximumTemperatureWaterIndex\":{},",
        "\"maximumTemperatureErrorK\":{},\"pressureRatioTo5Pa\":{},",
        "\"temperatureRatioTo1eMinus4K\":{},\"negativeWorkErrorReversesAllSigns\":true}}"
    ), receiver, model.cooling.layout.network_start + network.energy_row(receiver),
        w.chart_mass[receiver], w.chart_derivatives[receiver][0], w.chart_derivatives[receiver][1],
        w.chart_derivatives[receiver][2], w.chart_derivatives[receiver][3],
        w.chart_derivatives[receiver][3], compliance,
        positive_work_error_j, -positive_work_error_j, r.pressure, r.temperatures[receiver],
        maximum.0, maximum.1, r.pressure.abs() / PRESSURE_COMPARISON_PA,
        maximum.1.abs() / CALORIC_COMPARISON_K);
    Ok((json, r))
}

struct Report {
    json: String,
    anchor: Option<Response>,
    upper: Response,
}

fn report_current(model: &sm::Model, work: &sm::Workspace, physical_y: &[f64],
    anchor_row: usize, positive_work_error_j: f64) -> Result<Report, String>
{
    work.complete_energy_rate()?;
    let network = &model.cooling.network;
    let nw = network.config().water.len();
    let w = &work.cooling.network;
    if !positive_work_error_j.is_finite() || positive_work_error_j <= 0.
        || w.chart_derivatives.len() != nw || w.chart_mass.len() != nw
        || w.chart_mass.iter().any(|m| !m.is_finite() || *m <= 0.)
        || model.hydraulics.upper >= nw || physical_y.len() != model.dimension()
        || physical_y.iter().any(|v| !v.is_finite())
    {
        return Err("Invalid bank-work consequence report inputs".into());
    }
    let y = &physical_y[model.cooling.layout.network_start..model.cooling.layout.carrier_start];
    w.check_current_chart(network, y)?;
    let water = (0..nw).find(|&i|
        model.cooling.layout.network_start + network.energy_row(i) == anchor_row);
    let solid = (0..network.config().solids.len()).find(|&i|
        model.cooling.layout.network_start + network.energy_row(nw + i) == anchor_row);
    let secondary = (0..network.config().secondaries.len()).find(|&i|
        model.cooling.layout.network_start + network.secondary_energy_row(i) == anchor_row);
    let mut property_requests = 0;
    let anchor = if let Some(i) = water {
        Some(receiver_json(model, work, i, positive_work_error_j)?)
    } else if let Some(i) = solid {
        let capacity = network.config().solids[i].heat_capacity;
        let r = solid_response(capacity, -positive_work_error_j)?;
        let json = format!(concat!(
            "{{\"owner\":\"network-solid\",\"solidIndex\":{},\"energyRow\":{},",
            "\"energyCapacityJPerK\":{},\"positiveWorkErrorJ\":{},\"solidEnergyErrorJ\":{},",
            "\"pressureErrorPa\":0,\"maximumTemperatureErrorK\":{},",
            "\"pressureRatioTo5Pa\":0,\"temperatureRatioTo1eMinus4K\":{},",
            "\"negativeWorkErrorReversesAllSigns\":true}}"
        ), i, anchor_row, capacity, positive_work_error_j, -positive_work_error_j,
            r.temperatures[0], r.temperatures[0].abs() / CALORIC_COMPARISON_K);
        Some((json, r))
    } else if let Some(i) = secondary {
        let inventory = network.secondary_inventory(i);
        let temperature = y[network.secondary_temperature_row(i)];
        let pressure = y[network.secondary_pressure_row(i)];
        let state = w.secondary_states[i];
        let a = network.config().secondaries[i].derivatives(inventory,
            temperature, pressure)?;
        property_requests = 8; // Existing bounded local wet-property probes.
        let (capacity, r) = secondary_response(a, -positive_work_error_j)?;
        let json = format!(concat!(
            "{{\"owner\":\"closed-wet-secondary\",\"secondaryIndex\":{},\"energyRow\":{},",
            "\"currentTemperatureK\":{},\"currentPressurePa\":{},\"currentLiquidVolumeM3\":{},\"minimumWettedLiquidVolumeM3\":{},",
            "\"waterMassKg\":{},\"airMassKg\":{},\"nitrogenMassKg\":{},",
            "\"currentChartDerivativesUtUpGtGp\":[{},{},{},{}],\"derivativeUnits\":\"J/K,J/Pa,Pa/K,1\",",
            "\"equilibriumEnergyCapacityJPerK\":{},\"positiveWorkErrorJ\":{},\"secondaryEnergyErrorJ\":{},",
            "\"pressureErrorPa\":{},\"maximumTemperatureErrorK\":{},",
            "\"pressureRatioTo5Pa\":{},\"temperatureRatioTo1eMinus4K\":{},",
            "\"negativeWorkErrorReversesAllSigns\":true}}"
        ), i, anchor_row, temperature, pressure, state.liquid_volume,
            network.config().secondaries[i].minimum_wetted_liquid_volume,
            inventory.water, inventory.air, inventory.nitrogen,
            a[0], a[1], a[2], a[3], capacity, positive_work_error_j, -positive_work_error_j,
            r.pressure, r.temperatures[0], r.pressure.abs() / PRESSURE_COMPARISON_PA,
            r.temperatures[0].abs() / CALORIC_COMPARISON_K);
        Some((json, r))
    } else { None };
    let (supported, anchor_json, reason, anchor_response) = match anchor {
        Some((json, r)) => (true, json, "null", Some(r)),
        None => (false, "null".into(), "\"Energy-chart anchor is not an installed primary-water, network-solid or closed-secondary energy owner\"", None),
    };
    let (upper_json, upper) = receiver_json(model, work, model.hydraulics.upper, positive_work_error_j)?;
    let json = format!(concat!(
        "{{\"scope\":\"fixed-current geometry and each receiver's retained mass/species inventories; not trajectory or acoustic pressure bound\",",
        "\"comparisonBasis\":\"existing current-network chart-coherence scales, conservatively applied to local sensitivity; not plant limits\",",
        "\"bankClusters\":{},\"bankWorkPairJ\":{},\"fractionOf1JEnergyGate\":{},",
        "\"anchorRow\":{},\"anchorSupported\":{},\"unsupportedReason\":{},",
        "\"propertyRequests\":{},\"anchor\":{},\"physicalUpperReceiver\":{}}}"
    ), model.clusters(), positive_work_error_j, positive_work_error_j,
        anchor_row, supported, reason, property_requests, anchor_json, upper_json);
    Ok(Report { json, anchor: anchor_response, upper })
}

/// The actual fixed solver anchor and physical UPPER work receiver are separate
/// alternative sensitivities, never two simultaneous energy injections. Only a
/// secondary anchor requests properties: its existing current forward-chart
/// derivative probes, once. No state edits or full-model evaluation.
pub(super) fn report(model: &sm::Model, work: &sm::Workspace, physical_y: &[f64],
    anchor_row: usize, positive_work_error_j: f64) -> Result<String, String>
{
    Ok(report_current(model, work, physical_y, anchor_row, positive_work_error_j)?.json)
}

fn admit_response(r: &Response) -> Result<(), String> {
    if r.pressure.abs() > PRESSURE_COMPARISON_PA
        || r.temperatures.iter().any(|t| t.abs() > CALORIC_COMPARISON_K)
    {
        return Err("Bank-work sensitivity exceeds the selected pressure/caloric comparison".into());
    }
    Ok(())
}

/// This qualification selects the two stated cold comparison scales. Keep
/// that refusal separate from the general diagnostic's unsupported result.
pub(super) fn selected_report(model: &sm::Model, work: &sm::Workspace, physical_y: &[f64],
    anchor_row: usize, positive_work_error_j: f64) -> Result<String, String>
{
    let report = report_current(model, work, physical_y, anchor_row, positive_work_error_j)?;
    let anchor = report.anchor.ok_or_else(|| format!(
        "Selected bank-work qualification needs a supported installed energy anchor: {}", report.json))?;
    for r in [anchor, report.upper] {
        admit_response(&r).map_err(|e| format!("{e}: {}", report.json))?;
    }
    Ok(report.json)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(a: f64, b: f64) { assert!((a-b).abs() < 2e-14 * (1.+a.abs()+b.abs()), "{a} != {b}"); }
    #[test]
    fn fixed_mass_and_each_energy_are_reconstructed_with_work_sign() {
        let chart = [[2., -3., 5., 7.], [11., -13., 17., 19.]];
        for receiver in 0..2 {
            let work = 0.00052;
            let (_, r) = response(&chart, receiver, -work).unwrap();
            assert!(r.pressure < 0.); // A positive work error removes water E.
            let mut mass = 0.;
            for (i, [mp, mt, ep, et]) in chart.iter().enumerate() {
                mass += mp*r.pressure + mt*r.temperatures[i];
                close(ep*r.pressure + et*r.temperatures[i], if i==receiver {-work} else {0.});
            }
            close(mass, 0.);
            let (_, opposite) = response(&chart, receiver, work).unwrap();
            close(opposite.pressure, -r.pressure);
            for (a, b) in opposite.temperatures.iter().zip(r.temperatures) { close(*a, -b); }
        }
    }
    #[test]
    fn invalid_or_singular_current_charts_are_not_repaired() {
        assert!(response(&[], 0, 1.).is_err());
        assert!(response(&[[1.,0.,0.,0.]], 0, 1.).is_err());
        assert!(response(&[[0.,0.,0.,1.]], 0, 1.).is_err());
        assert!(response(&[[1.,1.,1.,1.]], 0, 1.).is_err());
        assert!(response(&[[f64::NAN,0.,0.,1.]], 0, 1.).is_err());
        assert!(response(&[[1.,0.,0.,1.]], 0, f64::INFINITY).is_err());
    }
    #[test]
    fn solid_and_closed_secondary_preserve_their_actual_energy_equations() {
        let a = [19., 3., -5., 7.]; // Existing [U_T,U_p,G_T,G_p] order.
        let capacity = 23.;
        for energy in [-0.00052, 0., 0.00052] {
            let solid = solid_response(capacity, energy).unwrap();
            close(capacity * solid.temperatures[0], energy);
            close(solid.pressure, 0.);
            let (_, secondary) = secondary_response(a, energy).unwrap();
            let dt = secondary.temperatures[0];
            let dp = secondary.pressure;
            close(a[0] * dt + a[1] * dp, energy);
            close(a[2] * dt + a[3] * dp, 0.);
            assert_eq!(dt.signum(), energy.signum());
            if energy != 0. { assert_eq!(dp.signum(), energy.signum()); }
        }
        for capacity in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(solid_response(capacity, 1.).is_err());
        }
        assert!(solid_response(1e-300, 1e300).is_err());
        for chart in [[0.,0.,0.,1.], [1.,1.,1.,1.], [1.,0.,0.,0.],
            [1.,0.,0.,-1.], [f64::NAN,0.,0.,1.]] {
            assert!(secondary_response(chart, 1.).is_err());
        }
        assert!(secondary_response(a, f64::INFINITY).is_err());
    }
    #[test]
    fn selected_comparisons_admit_boundary_and_refuse_either_signed_excess() {
        for sign in [-1., 1.] {
            let mut r = Response { pressure: sign*5., temperatures: vec![sign*1e-4] };
            admit_response(&r).unwrap();
            r.pressure = sign*5.00001;
            assert!(admit_response(&r).is_err());
            r.pressure = 0.; r.temperatures[0] = sign*1.00001e-4;
            assert!(admit_response(&r).is_err());
        }
    }
}

//! Fixed-state actual-network audit. No IDA memory or time advancement.
mod ida_support;
mod operating_network_audit;
mod operating_network_input;
use leitbild_plant_numerics::operating_network::*;
use std::io::{self, Read};

fn main() -> Result<(), String> {
    if std::env::args().len() != 1 {
        return Err("Matrix audit accepts numeric stdin only".into());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let mut tokens = input.split_whitespace();
    let parsed = operating_network_input::parse(&mut tokens)?;
    let n = Network::new(parsed.config)?;
    let dim = n.dimension();
    // Narrow diagnostic suffix: initial cj, captured cj, captured y and yp,
    // then the EXACT original driver q absolute weights, in contact order.
    let initial_cj: f64 = operating_network_input::value(&mut tokens)?;
    let captured_cj: f64 = operating_network_input::value(&mut tokens)?;
    if ![initial_cj, captured_cj]
        .iter()
        .all(|x| x.is_finite() && *x > 0.)
    {
        return Err("Positive finite audit cj required".into());
    }
    let y: Vec<f64> = (0..dim)
        .map(|_| operating_network_input::value(&mut tokens))
        .collect::<Result<_, _>>()?;
    let yp: Vec<f64> = (0..dim)
        .map(|_| operating_network_input::value(&mut tokens))
        .collect::<Result<_, _>>()?;
    let flow_weights: Vec<f64> = (0..n.config().hydraulic.len())
        .map(|_| operating_network_input::value(&mut tokens))
        .collect::<Result<_, _>>()?;
    if tokens.next().is_some() {
        return Err("Trailing fixed matrix audit input".into());
    }
    let original = n.initial_state()?;
    let mut workspace = Workspace::new(&n);
    workspace.evaluate(&n, &original, &vec![0.; dim], None)?;
    // Actual differential stock/flow rates with zero algebraic p/T entries;
    // this is a residual-consistent audit seed, not the full physical tangent.
    let original_rates = workspace.rates.clone();
    let nw = n.config().water.len();
    let mut weights = vec![0.; dim];
    for i in 0..nw {
        weights[5 * i] = 1e-5;
        weights[5 * i + 1] = original[5 * i] * workspace.liquids[i].cp * 1e-3;
        weights[5 * i + 2] = 1e-8;
        weights[5 * i + 3] = 100.;
        weights[5 * i + 4] = 1e-3;
    }
    for i in 0..n.config().solids.len() {
        weights[5 * nw + i] = n.config().solids[i].heat_capacity * 1e-3;
    }
    for (e, w) in flow_weights.into_iter().enumerate() {
        weights[n.flow_row(e)] = w;
    }
    if !weights.iter().all(|x| x.is_finite() && *x > 0.) {
        return Err("Finite positive actual weights required".into());
    }
    let began = std::time::Instant::now();
    operating_network_audit::fixed(
        &n,
        &original,
        &original_rates,
        &weights,
        [initial_cj, captured_cj],
        "original",
    )?;
    operating_network_audit::fixed(&n, &y, &yp, &weights, [initial_cj, captured_cj], "captured")?;
    println!(
        "{{\"scope\":\"fixed-matrix-audit-complete\",\"unknowns\":{dim},\"elapsed_s\":{},\"advancement_s\":0,\"IDAConstructed\":false,\"inputHorizon_s\":{},\"inputAllowance_s\":{}}}",
        began.elapsed().as_secs_f64(),
        parsed.horizon,
        parsed.budget
    );
    Ok(())
}

//! R4-NUC-SOURCE-ATOL (plan r4, lead 1 Nov): derived absolute tolerances on
//! the regional neutron populations and the delayed-neutron precursors,
//! under the operator-grade budgets (as R4-GUIDE-BASIS derives the guide
//! current's), with no new class.
//!
//! The stock scaled floor (`stockScaledAbsolute`, 1e-8 of each
//! coordinate's prepared full-power value) is about 2,000 times the
//! source-level populations of a hot-standby core (about 5e-12 of the
//! reference): there the error test does not see them, and one went through
//! zero (DUMP's T4, `OutsideDomain("neutrons", 5)`). Per coordinate of the
//! declared classes:
//!
//! ```text
//! atol_k = budgetFraction × u × |y_k(basis)| / scale_k     (scaled units)
//! ```
//!
//! - `u` is the source-range channel's relative uncertainty at its evidence
//!   threshold, from the NI.SHUTDOWN apparatus page's own counting band
//!   (`reference-nuclear-observation-window`): at `N = minimumExcessCount`,
//!   `A_L = (θN − c)/expm1(θ)`, `A_U = (θN + c)/(−expm1(−θ))`,
//!   `c = ln(2/α)`, `u = (A_U − A_L)/(2N)`;
//! - `|y_k(basis)|` is each coordinate's physical value at the declared
//!   hot-standby basis state (`ld01-source-atol`, model/operating-hot-
//!   spine.md: the state's name and sha256 and every value by label);
//! - the tightest of this and the coordinate's existing absolute tolerance
//!   applies (the derived rule's), so at power, where `rtol |y|` dominates,
//!   nothing changes in effect.
//!
//! A covered coordinate without a value, a value without a coordinate, or a
//! non-finite or non-positive result refuses. Nothing is clipped: there is
//! no positivity constraint.
use super::inputs::{MODEL, strict_block};
use leitbild_operating_plant::{
    joined::operator::Joined, network::Properties, thermal::WaterProperties,
};
use serde_json::{Value, json};

/// The page holding `ld01-source-atol`.
pub const PAGE: &str = "operating-hot-spine.md";
/// The NI.SHUTDOWN apparatus page holding the counting band's block.
pub const APPARATUS: &str = "world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/nuclear-observation-apparatus.md";

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Block {
    rule: String,
    budget_fraction: f64,
    classes: Vec<String>,
    basis: Basis,
    values: std::collections::BTreeMap<String, f64>,
}
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Basis {
    state: String,
    sha256: String,
    case: String,
    #[serde(rename = "afterZero_s")]
    after_zero_s: f64,
}

/// The source-range channel's relative uncertainty at its evidence
/// threshold, from the apparatus page's band, with the block it read.
pub fn relative_uncertainty(wiki: &str) -> Result<(f64, Value), String> {
    let path = format!("{wiki}/{APPARATUS}");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let b = strict_block(&text, "reference-nuclear-observation-window", &path)?;
    let f = |k: &str| {
        b[k].as_f64()
            .filter(|v| v.is_finite() && *v > 0.)
            .ok_or_else(|| format!("{path}: {k}"))
    };
    let (alpha, theta, n) = (f("alpha")?, f("theta")?, f("minimumExcessCount")?);
    let c = (2. / alpha).ln();
    let lower = ((theta * n - c) / theta.exp_m1()).max(0.);
    let upper = (theta * n + c) / -(-theta).exp_m1();
    let u = (upper - lower) / (2. * n);
    if !(u.is_finite() && u > 0.) {
        return Err(format!("source-range relative uncertainty {u}"));
    }
    Ok((
        u,
        json!({"page": APPARATUS, "alpha": alpha, "theta": theta, "count": n,
            "band": [lower, upper], "relative": u,
            "rule": "u = (A_U - A_L)/(2N) at N = minimumExcessCount, the page's fixed-theta counting band"}),
    ))
}

/// Apply the derived tolerances to `atol` (scaled units, the joined
/// layout's order) and return the receipt.
pub fn apply<P: Properties + WaterProperties>(
    joined: &Joined<P>,
    wiki: &str,
    atol: &mut [f64],
) -> Result<Value, String> {
    let path = format!("{wiki}/{MODEL}/{PAGE}");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let raw = strict_block(&text, "ld01-source-atol", &path)?;
    let block: Block =
        serde_json::from_value(raw.clone()).map_err(|e| format!("ld01-source-atol: {e}"))?;
    if block.rule != "R4-NUC-SOURCE-ATOL" {
        return Err(format!("ld01-source-atol: rule {}", block.rule));
    }
    if !(block.budget_fraction.is_finite() && block.budget_fraction > 0.) {
        return Err("ld01-source-atol: budgetFraction".into());
    }
    let (u, uncertainty) = relative_uncertainty(wiki)?;
    let factor = block.budget_fraction * u;
    let layout = joined.nuclear().layout();
    let base = joined.offsets().nuclear;
    let mut used = std::collections::BTreeSet::new();
    let (mut count, mut lowest, mut highest) = (0usize, f64::INFINITY, 0f64);
    for i in 0..layout.labels.len() {
        let class = format!("{:?}", layout.classes[i]);
        if !block.classes.contains(&class) {
            continue;
        }
        let label = &layout.labels[i];
        let v = *block
            .values
            .get(label)
            .ok_or_else(|| format!("ld01-source-atol: no basis value for {label}"))?;
        let a = factor * v.abs() / layout.scales[i];
        if !(a.is_finite() && a > 0.) {
            return Err(format!("ld01-source-atol: {label} gives {a}"));
        }
        let k = base + i;
        atol[k] = atol[k].min(a);
        used.insert(label.clone());
        count += 1;
        lowest = lowest.min(atol[k]);
        highest = highest.max(atol[k]);
    }
    if let Some(extra) = block.values.keys().find(|l| !used.contains(*l)) {
        return Err(format!(
            "ld01-source-atol: {extra} names no covered coordinate"
        ));
    }
    if count == 0 {
        return Err("ld01-source-atol: no covered coordinate".into());
    }
    Ok(
        json!({"rule": "R4-NUC-SOURCE-ATOL: atol_k = budgetFraction x u x |y_k(basis)| / scale_k, the tightest with the existing; no positivity constraint",
        "page": format!("{MODEL}/{PAGE}"), "block_sha256": leitbild_operating_plant::digest::sha256(strict_text(&text)?.as_bytes()),
        "budget_fraction": block.budget_fraction, "uncertainty": uncertainty, "factor": factor,
        "classes": block.classes, "basis": block.basis, "coordinates": count,
        "applied_scaled": {"lowest": lowest, "highest": highest}}),
    )
}

fn strict_text(text: &str) -> Result<&str, String> {
    let open = "```ld01-source-atol\n";
    let start = text.find(open).ok_or("no ld01-source-atol block")? + open.len();
    let end = start
        + text[start..]
            .find("\n```")
            .ok_or("unterminated ld01-source-atol block")?;
    Ok(&text[start..end])
}

/// The basis values a declared state gives: every coordinate of `classes`
/// in the joined layout, by label, physical (`y × scale`). Used once, to
/// write the block from the named basis state.
pub fn basis_values<P: Properties + WaterProperties>(
    joined: &Joined<P>,
    y: &[f64],
    classes: &[&str],
) -> Value {
    let layout = joined.nuclear().layout();
    let base = joined.offsets().nuclear;
    let mut out = serde_json::Map::new();
    for i in 0..layout.labels.len() {
        if classes.contains(&format!("{:?}", layout.classes[i]).as_str()) {
            out.insert(
                layout.labels[i].clone(),
                json!(y[base + i] * layout.scales[i]),
            );
        }
    }
    Value::Object(out)
}

//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The live composition (lead's ruling, 8 November): the unit the IC section
//! declares, its governor, DC groups and AUTO rod control, with the field
//! controller always. One place composes it, for the unit host and for the
//! harnesses that judge it, so a record is of the unit that runs.
use super::{
    dc::Dc,
    inputs::Inputs,
    plant::{self, Plant},
    profile::Solver,
    rod_control,
    s3::{self, S3Unit, Scaling},
    turbine::Turbine,
};
use crate::{
    If97,
    frame::{Diagnostic, MatrixRebuild},
    joined::{Integrated, JoinedSystem},
};
use leitbild_operating_plant::electrical::field;
use serde_json::{Value, json};

/// The unit the section declares, and the DC groups it composed with.
pub struct Composed<J: JoinedSystem> {
    pub unit: S3Unit<J>,
    pub dc: Option<Dc>,
}

/// Compose the unit the section declares from a saved S3 state: `singles`
/// names rod clusters composed singly (the harness's stuck-rod case only).
pub fn compose<J: JoinedSystem<Properties = If97>>(
    inputs: &Inputs,
    state: &Value,
    scaling: Scaling,
    solver: Solver,
    singles: &[usize],
    wrap: impl FnOnce(Integrated<If97>) -> Result<J, String>,
) -> Result<Composed<J>, String> {
    let wiki = &inputs.spine.wiki_root;
    let governor = inputs
        .ic
        .governor
        .declared
        .then(|| Turbine::from_wiki(wiki))
        .transpose()?;
    let dc = inputs
        .ic
        .dc
        .declared
        .then(|| Dc::from_wiki(wiki))
        .transpose()?;
    let unit = s3::compose_dc_with(
        inputs,
        state,
        scaling,
        solver,
        governor.as_ref(),
        singles,
        dc.as_ref(),
        wrap,
    )?;
    Ok(Composed { unit, dc })
}

/// How the composed unit runs.
#[derive(Clone, Copy)]
pub struct Options {
    pub diagnostic: Diagnostic,
    pub matrix_rebuild: MatrixRebuild,
    pub clock: fn() -> f64,
    /// Whether AUTO keeps its per-frame record: a harness's receipts read it,
    /// a live unit must not grow it.
    pub rod_records: bool,
}

/// The frame-driven unit: the protection, the PZR control, the field
/// controller on the electrical packet's timing, and AUTO rod control when
/// the section declares it, commissioned here. Returns the plant and the
/// rod commissioning's receipt (null when none is declared).
pub fn plant<J: JoinedSystem<Properties = If97>>(
    mut unit: S3Unit<J>,
    inputs: &Inputs,
    options: Options,
) -> Result<(Plant<J>, Value), String> {
    let elec: Value = serde_json::from_slice(
        &std::fs::read(&inputs.elec_path).map_err(|e| format!("{}: {e}", inputs.elec_path))?,
    )
    .map_err(|e| format!("{}: {e}", inputs.elec_path))?;
    let timing: field::Parameters = serde_json::from_value(elec["fieldProtection"].clone())
        .map_err(|e| {
            format!(
                "the electrical packet's fieldProtection (ld01-generator-field-protection): {e}"
            )
        })?;
    let (rods, receipt) = match rod_control::of_section(inputs, &mut unit)? {
        Some((mut client, commissioning)) => {
            client.recording = options.rod_records;
            (
                Some(client),
                json!({"wiki": inputs.spine.wiki_root, "commissioning": commissioning}),
            )
        }
        None => (None, Value::Null),
    };
    let mut plant = Plant::new(
        unit,
        &inputs.ic,
        plant::Config {
            field: Some(&timing),
            diagnostic: options.diagnostic,
            matrix_rebuild: options.matrix_rebuild,
            clock: options.clock,
        },
    )?;
    plant.rods = rods;
    Ok((plant, receipt))
}

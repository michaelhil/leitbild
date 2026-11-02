//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/dc-storage.md#installed-groups-and-initial-sizing
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/dc-storage.md#charging-connections-and-common-causes
//! PROC T5 (plan r4, lane ELEC, lead 1 Nov): the DC groups' composition
//! inputs, read from their strict wiki blocks on the DC page —
//! `reference-dc-actuation` (ACT.A/B), `ld01-dc-instrument-groups` (I1–I3)
//! and `ld01-dc-charging` (each group's normal and I3's alternate charging
//! bus). Report-only in LD-01 1.0 (lead ruling 2).
use leitbild_operating_plant::electrical::{dc::GroupParameters, dc_supply::Config};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const DC_PAGE: &str =
    "world/packs/process-plant/reference-designs/ld-01/systems/electrical/dc-storage.md";
/// The groups `reference-dc-actuation` holds (the page: "the common
/// ACT.A/B numerical storage/conversion basis").
pub const ACT_GROUPS: [&str; 2] = ["LD01.DC.ACT.A", "LD01.DC.ACT.B"];

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Basis {
    #[serde(rename = "usableEnergy_kWh")]
    usable_energy_kwh: f64,
    #[serde(rename = "continuousDuty_W")]
    continuous_duty_w: f64,
    #[serde(rename = "chargerLimit_W")]
    charger_limit_w: f64,
    #[serde(rename = "outputLimit_W")]
    output_limit_w: f64,
    charge_efficiency: f64,
    discharge_efficiency: f64,
    converter_efficiency: f64,
}
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Charging {
    normal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alternate: Option<String>,
}

/// The composition's inputs.
#[derive(Clone, Debug)]
pub struct Dc {
    pub groups: Vec<GroupParameters>,
    blocks: Value,
}

fn config(b: Basis) -> Config {
    Config {
        capacity_j: b.usable_energy_kwh * 3.6e6,
        normal_group_w: b.continuous_duty_w,
        charger_limit_w: b.charger_limit_w,
        output_limit_w: b.output_limit_w,
        charge_efficiency: b.charge_efficiency,
        discharge_efficiency: b.discharge_efficiency,
        converter_efficiency: b.converter_efficiency,
    }
}

impl Dc {
    /// The blocks of the wiki at `wiki`: every group of `ld01-dc-charging`,
    /// I1–I3 from `ld01-dc-instrument-groups`, ACT.A/B from
    /// `reference-dc-actuation`; refused unless each group has exactly one
    /// record.
    pub fn from_wiki(wiki: &str) -> Result<Self, String> {
        let path = format!("{wiki}/{DC_PAGE}");
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        Self::from_page(&text, &path)
    }
    /// [`Dc::from_wiki`] on the DC page's text, read from `path`.
    pub fn from_page(text: &str, path: &str) -> Result<Self, String> {
        let block = |fence: &str| super::inputs::strict_block(text, fence, path);
        let (act_v, inst_v, charging_v) = (
            block("reference-dc-actuation")?,
            block("ld01-dc-instrument-groups")?,
            block("ld01-dc-charging")?,
        );
        let act: Basis = serde_json::from_value(act_v.clone())
            .map_err(|e| format!("reference-dc-actuation: {e}"))?;
        // The instrument record is the ACT basis's fields plus its groups.
        let mut fields = inst_v.clone();
        let groups: Vec<String> = fields
            .as_object_mut()
            .and_then(|o| o.remove("groups"))
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| format!("ld01-dc-instrument-groups groups: {e}"))?
            .ok_or("ld01-dc-instrument-groups has no groups")?;
        let inst_basis: Basis = serde_json::from_value(fields)
            .map_err(|e| format!("ld01-dc-instrument-groups: {e}"))?;
        let charging: BTreeMap<String, Charging> = serde_json::from_value(charging_v.clone())
            .map_err(|e| format!("ld01-dc-charging: {e}"))?;
        let mut want: Vec<&str> = groups
            .iter()
            .map(String::as_str)
            .chain(ACT_GROUPS)
            .collect();
        want.sort_unstable();
        want.dedup();
        let have: Vec<&str> = charging.keys().map(String::as_str).collect();
        if want.len() != groups.len() + ACT_GROUPS.len() || want != have {
            return Err(format!(
                "ld01-dc-charging names {have:?}; the records name {want:?}"
            ));
        }
        let groups = charging
            .iter()
            .map(|(id, c)| {
                let basis = if ACT_GROUPS.contains(&id.as_str()) {
                    act
                } else {
                    inst_basis
                };
                GroupParameters {
                    id: id.clone(),
                    config: config(basis),
                    requested_w: basis.continuous_duty_w,
                    normal_bus: c.normal.clone(),
                    alternate_bus: c.alternate.clone(),
                }
            })
            .collect();
        Ok(Self {
            groups,
            blocks: json!({"page": path, "reference-dc-actuation": act_v,
                "ld01-dc-instrument-groups": inst_v, "ld01-dc-charging": charging_v}),
        })
    }
    pub fn receipt(&self) -> Value {
        json!({"blocks": self.blocks,
            "judgements": ["report-only in LD-01 1.0 (lead ruling 2): no consumer reads the delivered DC support (no I-group observation loss, no ACT release), so a storage event needs no integrator stop",
                "each group's request is its reference continuous duty as one aggregate (no itemized consumer)",
                "the normal alignment at the start: initial usable energy, output closed, charger on its normal bus, battery and output paths healthy"]})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The three blocks as the DC page states them (wiki 8797acb).
    const PAGE: &str = "```reference-dc-actuation
{\"usableEnergy_kWh\":16,\"continuousDuty_W\":2000,\"chargerLimit_W\":10000,\"outputLimit_W\":20000,\"chargeEfficiency\":0.95,\"dischargeEfficiency\":0.95,\"converterEfficiency\":0.92}
```
```ld01-dc-instrument-groups
{\"groups\":[\"LD01.DC.I1\",\"LD01.DC.I2\",\"LD01.DC.I3\"],\"usableEnergy_kWh\":24,\"continuousDuty_W\":3000,\"chargerLimit_W\":10000,\"outputLimit_W\":10000,\"chargeEfficiency\":0.95,\"dischargeEfficiency\":0.95,\"converterEfficiency\":0.92}
```
```ld01-dc-charging
{\"LD01.DC.I1\":{\"normal\":\"AC.A\"},\"LD01.DC.I2\":{\"normal\":\"AC.B\"},\"LD01.DC.I3\":{\"normal\":\"AC.A\",\"alternate\":\"AC.B\"},\"LD01.DC.ACT.A\":{\"normal\":\"AC.A\"},\"LD01.DC.ACT.B\":{\"normal\":\"AC.B\"}}
```
";
    #[test]
    fn the_five_groups_come_from_their_records() {
        let dc = Dc::from_page(PAGE, "dc-storage.md").unwrap();
        let ids: Vec<&str> = dc.groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "LD01.DC.ACT.A",
                "LD01.DC.ACT.B",
                "LD01.DC.I1",
                "LD01.DC.I2",
                "LD01.DC.I3"
            ]
        );
        let i3 = &dc.groups[4];
        assert_eq!(
            (
                i3.config.capacity_j,
                i3.requested_w,
                i3.config.output_limit_w
            ),
            (24. * 3.6e6, 3000., 10000.)
        );
        assert_eq!(
            (i3.normal_bus.as_str(), i3.alternate_bus.as_deref()),
            ("AC.A", Some("AC.B"))
        );
        let act_b = &dc.groups[1];
        assert_eq!(
            (
                act_b.config.capacity_j,
                act_b.requested_w,
                act_b.config.output_limit_w
            ),
            (16. * 3.6e6, 2000., 20000.)
        );
        assert_eq!(
            (act_b.normal_bus.as_str(), act_b.alternate_bus.as_deref()),
            ("AC.B", None)
        );
        // A group without a record, or an unknown field, refuses.
        assert!(
            Dc::from_page(
                &PAGE.replace(
                    "\"LD01.DC.ACT.B\":{\"normal\":\"AC.B\"}",
                    "\"LD01.DC.X\":{\"normal\":\"AC.B\"}"
                ),
                "p"
            )
            .is_err()
        );
        assert!(Dc::from_page(&PAGE.replace("\"groups\"", "\"extra\":1,\"groups\""), "p").is_err());
    }
}

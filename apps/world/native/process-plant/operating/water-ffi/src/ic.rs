//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! The acquired protection as a frame-driver client of the joined
//! operator: each observed quantity is a linear functional of the solver
//! coordinates, so its polynomial on an accepted step is read exactly from
//! the step's dense output; the holding loss the path decides becomes the
//! class-R command `HoldingLoss` at its frame instant.
//!
//! Quantities: the PZR roof pressure (PT1/2/3 at the +18.5 m roof tap, the
//! stratified cell's roof coordinate) and an SG's collapsed level
//! `V_l / area` (S3-D1.20). A loop flow has no mapping until its path and
//! nominal are selected.
use crate::frame::{Action, Change, Class, Client, Dense};
use leitbild_operating_plant::{
    ic::{
        packet::{Quantity, Section},
        protection::Protection,
    },
    joined::{block::Command, operator::Joined},
    network::{PZR_PRESSURE, Properties},
    thermal::WaterProperties,
};
use serde_json::{Value, json};

/// The holding loss's counting kind.
pub const HOLDING_LOSS: &str = "LD01.TRIP.HOLD loss";

pub struct ProtectionClient {
    pub protection: Protection,
    /// Per observed quantity: solver index and factor to physical units.
    observed: Vec<(Quantity, usize, f64)>,
    scratch: Vec<f64>,
    derivatives: Vec<Vec<f64>>,
}
impl ProtectionClient {
    /// The protection of `section`, balanced at the solver state `y`.
    pub fn new<P: Properties + WaterProperties>(
        section: &Section,
        joined: &Joined<P>,
        y: &[f64],
    ) -> Result<Self, String> {
        let scales = joined.scales();
        if scales.len() != y.len() {
            return Err("state layout".into());
        }
        let labels: Vec<String> = joined
            .layouts()
            .into_iter()
            .flat_map(|(_, l)| l.labels)
            .collect();
        let locate = |q: &Quantity| -> Result<(usize, f64), String> {
            match q {
                Quantity::PzrRoofPressure => {
                    let i = joined.network.pzr.base + PZR_PRESSURE;
                    Ok((i, scales[i]))
                }
                Quantity::SgCollapsedLevel { sg, area_m2 } => {
                    let label = format!("SG.{sg}.V_l");
                    let i = labels
                        .iter()
                        .position(|l| *l == label)
                        .ok_or_else(|| format!("no coordinate {label}"))?;
                    if !(area_m2.is_finite() && *area_m2 > 0.) {
                        return Err(format!("{label}: level area {area_m2}"));
                    }
                    Ok((i, scales[i] / area_m2))
                }
                Quantity::LoopFlow { loop_id, .. } => Err(format!(
                    "loop {loop_id} flow has no selected solver mapping"
                )),
            }
        };
        let mut observed = Vec::new();
        for q in section.families.iter().map(|f| &f.quantity) {
            if !observed.iter().any(|(o, _, _)| o == q) {
                let (i, factor) = locate(q)?;
                observed.push((q.clone(), i, factor));
            }
        }
        let protection = Protection::new(section, |q| {
            observed
                .iter()
                .find(|(o, _, _)| o == q)
                .map(|(_, i, f)| y[*i] * f)
                .ok_or_else(|| format!("{q:?} is not observed"))
        })?;
        let n = y.len();
        Ok(Self {
            derivatives: vec![Vec::new(); observed.len()],
            protection,
            observed,
            scratch: vec![0.; n],
        })
    }
    /// The observed quantities and their solver indices (for receipts).
    pub fn observed(&self) -> Value {
        json!(
            self.observed
                .iter()
                .map(|(q, i, f)| json!({"quantity": format!("{q:?}"), "index": i, "factor": f}))
                .collect::<Vec<_>>()
        )
    }
}
impl<S> Client<S> for ProtectionClient {
    fn name(&self) -> &str {
        "acquired protection"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        // The step polynomial's derivatives at `from`; IDA's order is at
        // most 5, the lag continuation's limit.
        let order = dense.order().min(5);
        for d in &mut self.derivatives {
            d.clear();
        }
        for j in 0..=order {
            dense.derivative(from, j, &mut self.scratch)?;
            for (d, (_, i, f)) in self.derivatives.iter_mut().zip(&self.observed) {
                d.push(self.scratch[*i] * f);
            }
        }
        for (d, (q, _, _)) in self.derivatives.iter().zip(&self.observed) {
            self.protection.advance(q, to - from, d)?;
        }
        Ok(())
    }
    fn frame(&mut self, k: u64, _t: f64, _dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        let frame = self.protection.frame_of();
        Ok(self
            .protection
            .frame(k)?
            .map(|lost| Change {
                due_s: frame.instant(lost),
                class: Class::R,
                kind: HOLDING_LOSS.into(),
                action: Action::Command(Command::HoldingLoss),
            })
            .into_iter()
            .collect())
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<S>>, String> {
        if command == Command::TurbineTripAcquired {
            self.protection.turbine_trip(t);
        }
        Ok(Vec::new())
    }
}

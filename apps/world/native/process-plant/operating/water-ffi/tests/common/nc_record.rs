//! Plan r4 X4.6 (lead approved): the natural-circulation record of a C5
//! run, record-only (class O through the case recorder; it never decides a
//! change or stops the integrator). At every frame's left limit, from the
//! same state the leg temperatures read: each loop's cold-return mass flow
//! (the acquired protection's loop-flow observation, kg/s), the hottest
//! core-exit cell (`CORE.*.2`, IF97 at the cell's pressure and specific
//! internal energy) with the saturation temperature at that cell's pressure,
//! and the loop-average Tavg `((Th + Tc)_A / 2 + (Th + Tc)_B / 2) / 2` from
//! the leg temperatures. Read by `lanes/r4-feed/nc-judge-1.py` (pinned).
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::{
    network::{Network, Properties},
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::{If97, ic::Readings};
use serde_json::{Value, json};

pub const COLUMNS: [&str; 6] = [
    "t_s",
    "loop_A_kg_s",
    "loop_B_kg_s",
    "core_exit_K",
    "core_exit_saturation_K",
    "tavg_K",
];

pub struct NcRecord {
    readings: Readings,
    /// The core-exit cells (`CORE.*.2`).
    exit: Vec<usize>,
    pub rows: Vec<Value>,
}

impl NcRecord {
    /// The recorder over the packet's region ids and the protection's
    /// readings (which carry the loop-flow observations).
    pub fn new(ids: &[String], readings: Readings) -> Result<Self, String> {
        let exit: Vec<usize> = (0..ids.len())
            .filter(|i| ids[*i].starts_with("CORE.") && ids[*i].ends_with(".2"))
            .collect();
        if exit.is_empty() {
            return Err("no CORE.*.2 cell".into());
        }
        Ok(Self {
            readings,
            exit,
            rows: Vec::new(),
        })
    }

    /// One row at `t` from the left-limit state `y`, with the leg
    /// temperatures `[HOT.A, HOT.B, COLD.A, COLD.B]` of the same state;
    /// `cell` reads a cell's (temperature, mass, pressure).
    pub fn sample<P: Properties>(
        &mut self,
        net: &Network<P>,
        y: &[f64],
        t: f64,
        legs: [f64; 4],
        cell: impl Fn(&Network<P>, &[f64], usize) -> Result<(f64, f64), String>,
    ) -> Result<(), String> {
        let values = self.readings.values(y)?;
        let mut flows = [f64::NAN; 2];
        for (key, v) in values.as_object().ok_or("readings are not an object")? {
            for (k, id) in ["A", "B"].iter().enumerate() {
                if key.starts_with(&format!("LoopFlow {{ loop_id: \"{id}\"")) {
                    let nominal = key
                        .split("nominal_kg_s: Some(")
                        .nth(1)
                        .and_then(|r| r.split(')').next())
                        .and_then(|n| n.parse::<f64>().ok())
                        .ok_or_else(|| format!("loop {id}: no resolved nominal in {key}"))?;
                    flows[k] = v.as_f64().ok_or("loop flow is not a number")? * nominal;
                }
            }
        }
        if flows.iter().any(|f| !f.is_finite()) {
            return Err("a loop flow observation is missing".into());
        }
        let scales = net.scales();
        let (mut hottest, mut pressure) = (f64::NEG_INFINITY, f64::NAN);
        for &c in &self.exit {
            let (temperature, _) = cell(net, y, c)?;
            if temperature > hottest {
                hottest = temperature;
                let l = &net.cell_layout[c];
                pressure = y[l.base] * scales[l.base];
            }
        }
        let saturation = WaterProperties::saturation(&If97, Scalar::constant(pressure))
            .map_err(|e| format!("core-exit saturation: {e}"))?
            .temperature
            .value;
        let tavg = ((legs[0] + legs[2]) / 2. + (legs[1] + legs[3]) / 2.) / 2.;
        self.rows
            .push(json!([t, flows[0], flows[1], hottest, saturation, tavg]));
        Ok(())
    }

    pub fn receipt(&self) -> Value {
        json!({"columns": COLUMNS, "rule": "X4.6 record-only: loop flow = the protection's loop-flow observation times its resolved nominal; core exit = the hottest CORE.*.2 cell with saturation at its pressure; Tavg = loop average of the leg temperatures; every frame's left limit", "rows": self.rows})
    }
}

//! The continuous three-element SG level control's observation (plan r4
//! X4.1): the control lives in the SG owner as differential coordinates
//! (`sg::secondary`, `control::feed`), so this client never decides a
//! change and never stops the integrator (class O). At each frame's left
//! limit it records, per SG, the apparent level `(V_l + V_sub) / A`, the
//! NR1, FT.STEAM and FW.FT lags, both integrals, the FCV stem and the
//! branch flow, for the receipt.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::{joined::operator::Joined, sg::packet};
use leitbild_operating_water::{
    If97,
    frame::{Change, Client, Dense},
};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug)]
struct Sg {
    liquid: (usize, f64),
    submerged: (usize, f64),
    /// NR1, FT.STEAM, FW.FT lags, IL, IF, FCV.u, branch flow, startup valve.
    control: [(usize, f64); 8],
}

/// The feed control's per-frame record of every SG.
pub struct FeedClient {
    area_m2: f64,
    sgs: Vec<Sg>,
    scratch: Vec<f64>,
    /// Per frame: index, time and per SG `[apparent level, NR1, FT.STEAM,
    /// FW.FT, IL, IF, FCV position, branch flow, startup valve]`.
    pub series: Vec<(u64, f64, Vec<[f64; 9]>)>,
}

impl FeedClient {
    /// The recorder of a composed operator; `None` without a feed train.
    pub fn commission(
        joined: &Joined<If97>,
        section: &packet::Section,
        n: usize,
    ) -> Result<Option<Self>, String> {
        let (Some(_), Some(level)) = (section.feed_train, section.apparent_level.as_ref()) else {
            return Ok(None);
        };
        let at = |label: String| -> Result<(usize, f64), String> {
            let mut k = 0;
            for (owner, layout) in joined.layouts() {
                for (i, l) in layout.labels.iter().enumerate() {
                    if owner == "secondary" && *l == label {
                        return Ok((k, layout.scales[i]));
                    }
                    k += 1;
                }
            }
            Err(format!("no coordinate {label}"))
        };
        let mut sgs = Vec::new();
        for g in &section.steam_generators {
            let id = &g.id;
            let c = |l: &str| at(format!("FW.{id}.{l}"));
            sgs.push(Sg {
                liquid: at(format!("SG.{id}.V_l"))?,
                submerged: at(format!("SG.{id}.V_sub"))?,
                control: [
                    c("NR1.lag")?,
                    c("FT.STEAM.lag")?,
                    c("FW.FT.lag")?,
                    c("IL")?,
                    c("IF")?,
                    c("FCV.u")?,
                    c("m")?,
                    c("SF.u")?,
                ],
            });
        }
        Ok(Some(Self {
            area_m2: level.indication.indicated_level_area_m2,
            sgs,
            scratch: vec![0.; n],
            series: Vec::new(),
        }))
    }

    /// The dense-output buffer for the composed state's dimension.
    pub fn resize(&mut self, n: usize) {
        self.scratch = vec![0.; n];
    }

    /// The receipt section.
    pub fn receipt(&self) -> Value {
        json!({"realization": "continuous (owner 31 Oct 2026): lags, integrals and the FCV stem are SG-owner coordinates; this client only records",
            "columns": ["apparent_level_m", "nr1_lag_m", "ft_steam_lag_kg_s", "fw_ft_lag_kg_s", "il", "if", "fcv_u", "branch_kg_s", "startup_u"],
            "series": self.series.iter().map(|(k, t, v)| json!([k, t, v])).collect::<Vec<_>>()})
    }
}

impl<S> Client<S> for FeedClient {
    fn name(&self) -> &str {
        "LD01.FW three-element SG level control (record)"
    }
    fn advance(&mut self, _dense: &dyn Dense, _from: f64, _to: f64) -> Result<(), String> {
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        dense.derivative(t, 0, &mut self.scratch)?;
        let y = &self.scratch;
        let v = |(i, s): (usize, f64)| y[i] * s;
        let record = self
            .sgs
            .iter()
            .map(|g| {
                let mut r = [0.; 9];
                r[0] = (v(g.liquid) + v(g.submerged)) / self.area_m2;
                for (j, c) in g.control.iter().enumerate() {
                    r[j + 1] = v(*c);
                }
                r
            })
            .collect();
        self.series.push((k, t, record));
        Ok(Vec::new())
    }
}

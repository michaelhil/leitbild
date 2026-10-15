//! The S3 cases' declaration (`ld01-s3-cases-c1c3`) as data: the block, its
//! pin against the decision log's last RP1 row naming it, the TBD register,
//! and the refusals of one case.
//!
//! The page is `LD01_S3_DECLARATION` (a markdown file holding the block),
//! else the wiki's `build-readiness.md` under `LD01_WIKI_ROOT`; the log is
//! `LD01_S3_DECISION_LOG`, else the wiki's `decision-log.md`.
use crate::{
    gates::{Block, wiki_model},
    guards,
};
use serde_json::{Value, json};

pub const FENCE: &str = "ld01-s3-cases-c1c3";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Case {
    C1,
    C2,
    C3,
}

impl Case {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "C1" => Ok(Self::C1),
            "C2" => Ok(Self::C2),
            "C3" => Ok(Self::C3),
            other => Err(format!("case {other}: C1, C2 or C3")),
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::C1 => "C1",
            Self::C2 => "C2",
            Self::C3 => "C3",
        }
    }

    /// What the model (on this branch) does not yet offer a case, so the
    /// harness cannot execute it as declared: each is a refusal for evidence
    /// and a disclosed deviation in a preview.
    pub fn missing_prerequisites(self) -> Vec<&'static str> {
        match self {
            Self::C1 => vec![
                "prerequisite 10: the generator exporting through the Grid exchange is not composed in the joined operator (ELEC's slice runs stand-alone)",
                "prerequisite 5: IC-CTRL's PZR pressure controller (AUTO) has no client the harness can compose (PzrClient is private to s3_c1_pzr_control.rs)",
            ],
            Self::C2 => vec![
                "prerequisite 8: ELEC's slice (breaker, unit-to-reserve transfer, contactors) is not composed in the joined operator, so C2.O2's breaker, C2.O3 and C2.N5 cannot be judged",
                "loop-flow acquisition: the protection client refuses Quantity::LoopFlow, so C2.N4 cannot be judged",
            ],
            Self::C3 => vec![
                "R3's pump-off donor law (PHASE-L1) is not in the model",
                "no RCP supply-loss command on the joined spine (only S1's network-level set_rotor_state)",
                "loop-flow acquisition: the protection client refuses Quantity::LoopFlow, so the low-flow cause cannot be acquired",
            ],
        }
    }
}

/// The declaration a case reads.
pub struct Declaration {
    pub block: Block,
    pub log: Option<String>,
    pub log_page: String,
}

impl Declaration {
    pub fn load() -> Result<Self, String> {
        let page = std::env::var("LD01_S3_DECLARATION")
            .unwrap_or_else(|_| format!("{}/build-readiness.md", wiki_model()));
        let log_page = std::env::var("LD01_S3_DECISION_LOG")
            .unwrap_or_else(|_| format!("{}/decision-log.md", wiki_model()));
        Ok(Self {
            block: Block::from_page(&page, FENCE)?,
            log: std::fs::read_to_string(&log_page).ok(),
            log_page,
        })
    }

    pub fn pin(&self) -> Result<Value, String> {
        guards::pin_of(&self.block, self.log.as_deref(), &self.log_page)
    }

    pub fn tbd(&self) -> Result<Value, String> {
        guards::tbd_state(&self.block, self.log.as_deref())
    }

    /// Why a case may not run as evidence: the block not pinned, any of the
    /// case's own TBD values open or unlogged, a null the register does not
    /// list, and every missing model prerequisite. Empty when it may.
    pub fn refusals(&self, case: Case) -> Result<Vec<String>, String> {
        let pin = self.pin()?;
        let tbd = self.tbd()?;
        Ok(case_refusals(case, &pin, &tbd))
    }

    /// The case's section of the block (`cases.<C>`).
    pub fn case(&self, case: Case) -> Value {
        self.block.whole(&format!("/cases/{}", case.key()))
    }
}

/// [`Declaration::refusals`] on a pin and TBD state (pure).
pub fn case_refusals(case: Case, pin: &Value, tbd: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if pin["pinned"] != json!(true) {
        out.push(format!(
            "{FENCE} is not pinned: declared sha256 {} against the frozen {}",
            pin["declared_sha256"], pin["frozen_sha256"]
        ));
    }
    let own = format!("cases.{}.", case.key());
    for o in tbd["open"].as_array().into_iter().flatten() {
        if o["key"].as_str().is_some_and(|k| k.starts_with(&own)) {
            out.push(format!("TBD({}) {} is open", o["lane"], o["key"]));
        }
    }
    for f in tbd["fills"].as_array().into_iter().flatten() {
        if f["logged_row"].is_null() && f["key"].as_str().is_some_and(|k| k.starts_with(&own)) {
            out.push(format!("the fill of {} has no decision-log row", f["key"]));
        }
    }
    for n in tbd["undeclared_nulls"].as_array().into_iter().flatten() {
        out.push(format!("{n} is null and not in the TBD register"));
    }
    out.extend(
        case.missing_prerequisites()
            .into_iter()
            .map(|m| format!("not executable as declared: {m}")),
    );
    out
}

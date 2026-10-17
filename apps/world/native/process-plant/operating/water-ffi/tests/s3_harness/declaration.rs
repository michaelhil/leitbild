//! The S3 cases' declaration (`ld01-s3-cases-c1c3`; C5's own
//! `ld01-s3-cases-c5`, C5L) as data: the block, its pin against the
//! decision log's last RP1 row naming it, the TBD register, and the
//! refusals of one case. C5's block holds the common rules under
//! `commonRules` ([`Declaration::common`]), as C4's own block
//! (`ld01-s3-cases-c4`, C4 lane) does.
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
    C4,
    C5,
}

impl Case {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "C1" => Ok(Self::C1),
            "C2" => Ok(Self::C2),
            "C3" => Ok(Self::C3),
            "C4" => Ok(Self::C4),
            "C5" => Ok(Self::C5),
            other => Err(format!("case {other}: C1, C2, C3, C4 or C5")),
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::C1 => "C1",
            Self::C2 => "C2",
            Self::C3 => "C3",
            Self::C4 => "C4",
            Self::C5 => "C5",
        }
    }
    /// The block that declares the case.
    pub fn fence(self) -> &'static str {
        match self {
            // C4 (C4 lane): its own block, `ld01-s3-cases-c4` r1.
            Self::C4 => super::c4::FENCE,
            Self::C5 => super::c5::FENCE,
            _ => FENCE,
        }
    }

    /// What the model (on this branch) does not yet offer a case, so the
    /// harness cannot execute it as declared: each is a refusal for evidence
    /// and a disclosed deviation in a preview.
    pub fn missing_prerequisites(self) -> Vec<&'static str> {
        match self {
            // C1 exchanges with the test-only Grid stand-in under D1 + D2
            // (C5L; owner R5-F4: no live Grid), as C5 does.
            Self::C1 => Vec::new(),
            // Loop-flow acquisition is now the ic section's (KERN 53ae7c05);
            // a section without it leaves its lines not executable, judged
            // per line from the protection's own function list.
            Self::C2 | Self::C3 => Vec::new(),
            // C5's exchange partner is the test-only Grid stand-in (owner
            // R5-F4), its C5 plan reproduced in-process (disclosed in the
            // receipt, not a model prerequisite).
            Self::C5 => Vec::new(),
            Self::C4 => Vec::new(),
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
        Self::load_fence(FENCE)
    }

    /// The declaration of `case` (its own block for C5).
    pub fn load_case(case: Case) -> Result<Self, String> {
        Self::load_fence(case.fence())
    }

    fn load_fence(fence: &str) -> Result<Self, String> {
        let page = std::env::var("LD01_S3_DECLARATION")
            .unwrap_or_else(|_| format!("{}/build-readiness.md", wiki_model()));
        let log_page = std::env::var("LD01_S3_DECISION_LOG")
            .unwrap_or_else(|_| format!("{}/decision-log.md", wiki_model()));
        Ok(Self {
            block: Block::from_page(&page, fence)?,
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

    /// A common rule's pointer: C5's block holds them under `commonRules`.
    pub fn common(&self, pointer: &str) -> String {
        if self.block.fence == super::c5::FENCE || self.block.fence == super::c4::FENCE {
            format!("/commonRules{pointer}")
        } else {
            pointer.to_string()
        }
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
            "{} is not pinned: declared sha256 {} against the frozen {}",
            case.fence(),
            pin["declared_sha256"],
            pin["frozen_sha256"]
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

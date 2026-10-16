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
/// C4's own block (wiki 7201bcd, merged into integ3).
pub const C4_FENCE: &str = "ld01-s3-cases-c4";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Case {
    C1,
    C2,
    C3,
    C4,
}

impl Case {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "C1" => Ok(Self::C1),
            "C2" => Ok(Self::C2),
            "C3" => Ok(Self::C3),
            "C4" => Ok(Self::C4),
            other => Err(format!("case {other}: C1, C2, C3 or C4")),
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::C1 => "C1",
            Self::C2 => "C2",
            Self::C3 => "C3",
            Self::C4 => "C4",
        }
    }

    /// What the model (on this branch) does not yet offer a case, so the
    /// harness cannot execute it as declared: each is a refusal for evidence
    /// and a disclosed deviation in a preview.
    pub fn missing_prerequisites(self) -> Vec<&'static str> {
        match self {
            Self::C1 => vec![
                "prerequisite 10 / request D: the generator exports into the electrical packet's fixed boundary (line voltage and frequency), not request D's Grid exchange (D1 + D2)",
            ],
            // Loop-flow acquisition is now the ic section's (KERN 53ae7c05);
            // a section without it leaves its lines not executable, judged
            // per line from the protection's own function list.
            Self::C2 | Self::C3 | Self::C4 => Vec::new(),
        }
    }
}

/// The declaration a case reads.
pub struct Declaration {
    pub block: Block,
    pub log: Option<String>,
    pub log_page: String,
    /// C4's own pinned block (`ld01-s3-cases-c4`, RP1-pin-s3-c4), read beside
    /// the C1–C3 block whose common rules it copies verbatim; the case's
    /// pin, TBD register and section are this block's.
    pub case_block: Option<Block>,
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
            case_block: None,
        })
    }

    /// The declaration one case reads: C4 adds its own block, from
    /// `LD01_S3_C4_DECLARATION` or else the same page.
    pub fn load_for(case: Case) -> Result<Self, String> {
        let mut d = Self::load()?;
        if case == Case::C4 {
            let page = std::env::var("LD01_S3_C4_DECLARATION")
                .or_else(|_| std::env::var("LD01_S3_DECLARATION"))
                .unwrap_or_else(|_| format!("{}/build-readiness.md", wiki_model()));
            d.case_block = Some(Block::from_page(&page, C4_FENCE)?);
        }
        Ok(d)
    }

    /// The block that declares the case's lines: C4's own, else C1–C3's.
    pub fn case_block(&self) -> &Block {
        self.case_block.as_ref().unwrap_or(&self.block)
    }

    pub fn pin(&self) -> Result<Value, String> {
        guards::pin_of(self.case_block(), self.log.as_deref(), &self.log_page)
    }

    pub fn tbd(&self) -> Result<Value, String> {
        guards::tbd_state(self.case_block(), self.log.as_deref())
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
        self.case_block().whole(&format!("/cases/{}", case.key()))
    }
}

/// [`Declaration::refusals`] on a pin and TBD state (pure).
pub fn case_refusals(case: Case, pin: &Value, tbd: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if pin["pinned"] != json!(true) {
        let fence = if case == Case::C4 { C4_FENCE } else { FENCE };
        out.push(format!(
            "{fence} is not pinned: declared sha256 {} against the frozen {}",
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

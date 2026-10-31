//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The unit's explicit inputs: the compiled joined packet, the wiki whose
//! strict blocks the composition reads (`ld01-s1-gates`,
//! `ld01-accuracy-contract`) and, for the S3 composition, the compiled
//! sections (I&C, PZR pressure control, ELEC's packet). The environment is
//! read here only, by the `from_env` constructors the tests and the host
//! call; the composition itself never reads it.
use leitbild_operating_plant::ic::packet::Section as IcSection;
use serde_json::Value;

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?)
        .map_err(|e| format!("{path}: {e}"))
}

/// The single JSON object of the strict block `fence` on a page, refused
/// when the block is absent, repeated or unterminated.
pub fn strict_block(text: &str, fence: &str, page: &str) -> Result<Value, String> {
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .ok_or_else(|| format!("{page} has no {fence} block"))?
        + open.len();
    if text[start..].contains(&open) {
        return Err(format!("{page} holds more than one {fence} block"));
    }
    let end = start
        + text[start..]
            .find("\n```")
            .ok_or_else(|| format!("{page}: unterminated {fence} block"))?;
    serde_json::from_str(&text[start..end]).map_err(|e| format!("{fence} in {page}: {e}"))
}

/// The packet and the wiki of a composition.
#[derive(Clone, Debug)]
pub struct Spine {
    /// The compiled joined packet's path (a saved state names it) and bytes.
    pub packet_path: String,
    pub packet: Vec<u8>,
    /// The wiki root (a checkout or a `git archive` directory).
    pub wiki_root: String,
    /// The wiki commit the root is verified to be, and the repository that
    /// resolves it (receipt provenance only).
    pub wiki_commit: Option<String>,
    pub wiki_repository: Option<String>,
}

/// The LD-01 model directory below a wiki root.
pub const MODEL: &str = "world/packs/process-plant/reference-designs/ld-01/model";

impl Spine {
    /// `LD01_OPERATING_HOT_SPINE_PACKET`, `LD01_WIKI_ROOT`, and for the
    /// receipts' provenance `LD01_WIKI_COMMIT` and `LD01_WIKI_REPOSITORY`.
    pub fn from_env() -> Result<Self, String> {
        let packet_path = env("LD01_OPERATING_HOT_SPINE_PACKET")?;
        let packet = std::fs::read(&packet_path).map_err(|e| format!("{packet_path}: {e}"))?;
        Ok(Self {
            packet_path,
            packet,
            wiki_root: env("LD01_WIKI_ROOT")?,
            wiki_commit: std::env::var("LD01_WIKI_COMMIT").ok(),
            wiki_repository: std::env::var("LD01_WIKI_REPOSITORY").ok(),
        })
    }
    /// A model page of the wiki, e.g. `build-readiness.md`.
    pub fn model_page(&self, page: &str) -> String {
        format!("{}/{MODEL}/{page}", self.wiki_root)
    }
    /// The strict block `fence` of the model page `page`.
    pub fn model_block(&self, page: &str, fence: &str) -> Result<Value, String> {
        let path = self.model_page(page);
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        strict_block(&text, fence, &path)
    }
    /// `ld01-s1-gates` (build-readiness): S1's tolerance classes and
    /// settling, shared by S2 and S3.
    pub fn s1_gates(&self) -> Result<Value, String> {
        self.model_block("build-readiness.md", "ld01-s1-gates")
    }
    /// `ld01-accuracy-contract` (operating-hot-spine): the credited outputs'
    /// budgets.
    pub fn accuracy_contract(&self) -> Result<Value, String> {
        self.model_block("operating-hot-spine.md", "ld01-accuracy-contract")
    }
    /// The packet as JSON.
    pub fn packet_json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.packet).map_err(|e| format!("{}: {e}", self.packet_path))
    }
}

/// The S3 composition's inputs: the spine and the compiled sections.
#[derive(Clone, Debug)]
pub struct Inputs {
    pub spine: Spine,
    pub ic_path: String,
    pub ic: IcSection,
    pub control_path: String,
    /// The wiki root holding the PZR pressure channel block.
    pub control_wiki: String,
    pub elec_path: String,
}

impl Inputs {
    /// [`Spine::from_env`] with `LD01_IC_SECTION`,
    /// `LD01_PZR_CONTROL_SECTION`, `LD01_PZR_CONTROL_WIKI` and `ELEC_PACKET`.
    pub fn from_env() -> Result<Self, String> {
        let ic_path = env("LD01_IC_SECTION")?;
        let ic: IcSection = serde_json::from_value(read_json(&ic_path)?)
            .map_err(|e| format!("ic section {ic_path}: {e}"))?;
        Ok(Self {
            spine: Spine::from_env()?,
            ic,
            ic_path,
            control_path: env("LD01_PZR_CONTROL_SECTION")?,
            control_wiki: env("LD01_PZR_CONTROL_WIKI")?,
            elec_path: env("ELEC_PACKET")?,
        })
    }
}

//! R4-NUC-POISON-EQ (plan r4, lead 1 Nov): the poison equilibrium step of
//! the full-power preparation, and its check.
//!
//! The prepared hot state's poisons are at equilibrium for the prepared hot
//! reference's flux. The composed plant then settles slightly below that
//! flux, so iodine and xenon are left off their own equilibrium and xenon
//! keeps building for hours (X4RUN H1). This step sets each replica group's
//! I-135, Xe-135, Pm-149 and Sm-149 to the algebraic equilibrium of the
//! model's own poison law (`poisons.rs`, as `joined/nuclear.rs` feeds it) at
//! a settled state's own fission rate and exposure:
//!
//! ```text
//! F_g   = sum over g's supports  G_ref,k * fissile_g / fissile_ref,g * N_region(k)
//! phi_g = sum over g's supports  h_k * N_region(k)
//! I = yI F / lI;  Xe = (yXe F + lI I) / (lXe + sXe phi);  Pm = yPm F / lPm;  Sm = (ySm F + lPm Pm) / (sSm phi)
//! ```
//!
//! Exactly these four coordinates of each group change in the state (and
//! their `yp`, set to the law's rate at the new values: zero at the flux
//! state); every other coordinate keeps its bits. The packet is untouched:
//! its prepared poisons stay the feedback reference. The new values are
//! checked against `poisons::Model::rates` (relative residual below 1e-12).
//!
//! - `equilibrate_the_poisons`: `LD01_POISON_STATE` (the state to write
//!   from, the S2 settled state), `LD01_POISON_FLUX_STATE` (the settled state
//!   whose fission rate and exposure the equilibrium takes; the same file on
//!   the first pass, the last S3 settled state after), `LD01_POISON_OUT` (the
//!   new state, never overwritten) and `LD01_POISON_RECORD`.
//! - `check_the_poison_equilibrium`: `LD01_POISON_STATE` (a settled state)
//!   and `LD01_POISON_RECORD`: each group's four poisons against the
//!   equilibrium at that state's own fission rate and exposure, judged by
//!   the wiki's `ld01-poison-equilibrium` block (`LD01_WIKI_ROOT`).
//!
//! Both select the water method from `LD01_S3_WATER` (unset SBTL), as every
//! harness does, before any water call. Ignored: one call per state.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::poisons;
use leitbild_operating_water::unit::spine::started_full_composition;
use serde_json::{Value, json};

const SPECIES: [&str; 4] = ["I135", "Xe135", "Pm149", "Sm149"];
/// `MATERIALS` order in joined/nuclear.rs: fissile, fertile, I, Xe, Pm, Sm.
const FISSILE: usize = 0;
const POISON0: usize = 2;
const PAGE: &str =
    "world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}
fn bits(v: &[f64]) -> Vec<String> {
    v.iter().map(|x| format!("{:016x}", x.to_bits())).collect()
}
fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect()
}
fn select_water() -> Value {
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    json!(water)
}
fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The packet's poison law constants, as joined/nuclear.rs compiles them.
struct Law {
    decay: [f64; 3],
    yields: [f64; 4],
    sigma_xe: f64,
    sigma_sm: f64,
}
impl Law {
    fn of(packet: &Value) -> Self {
        let e = &packet["hot"]["energy"];
        let v = |k: &str| -> Vec<f64> {
            e[k].as_array()
                .unwrap_or_else(|| panic!("{k}"))
                .iter()
                .map(|x| x.as_f64().expect("number"))
                .collect()
        };
        let (d, y) = (v("poison_decay_per_s"), v("poison_yields_per_fission"));
        Self {
            decay: [d[0], d[1], d[2]],
            yields: [y[0], y[1], y[2], y[3]],
            sigma_xe: e["xenon_cross_section_m2"].as_f64().expect("sigma Xe"),
            sigma_sm: e["samarium_cross_section_m2"].as_f64().expect("sigma Sm"),
        }
    }
    fn model(&self) -> poisons::Model {
        poisons::Model::new(poisons::Parameters {
            decay_per_s: self.decay,
            direct_atoms_per_fission: self.yields,
        })
        .unwrap_or_else(|e| panic!("{e}"))
    }
    fn input(&self, fissions: f64, phi: f64) -> poisons::Input {
        poisons::Input {
            fissions_per_s: fissions,
            capture_per_s: [0., self.sigma_xe * phi, 0., self.sigma_sm * phi],
        }
    }
    /// The algebraic equilibrium of the law at `(F, phi)`.
    fn equilibrium(&self, f: f64, phi: f64) -> [f64; 4] {
        let [li, lx, lp] = self.decay;
        let [yi, yx, yp, ys] = self.yields;
        let i = yi * f / li;
        let p = yp * f / lp;
        [
            i,
            (yx * f + li * i) / (lx + self.sigma_xe * phi),
            p,
            (ys * f + lp * p) / (self.sigma_sm * phi),
        ]
    }
}

/// The joined composition's nuclear block: where each group's coordinates
/// live in `y` and how its fission rate and exposure follow from a state.
struct Block {
    joined: leitbild_operating_plant::joined::operator::Joined<leitbild_operating_water::If97>,
    base: usize,
    scales: Vec<f64>,
    groups: usize,
}
impl Block {
    fn new() -> Self {
        let started = started_full_composition(&common::spine()).expect("the joined composition");
        let base = started.joined.offsets().nuclear;
        let scales = started.joined.scales().to_vec();
        let groups = started.joined.nuclear().replica_groups();
        Self {
            joined: started.joined,
            base,
            scales,
            groups,
        }
    }
    fn value(&self, y: &[f64], local: usize) -> f64 {
        y[self.base + local] * self.scales[self.base + local]
    }
    fn index(&self, g: usize, k: usize) -> usize {
        self.base + self.joined.nuclear().material(g, k)
    }
    /// Each group's fission rate (1/s) and exposure (1/(m2 s)) at `y`: the
    /// feedback law's own sums (source_feedback.rs `evaluate`).
    fn flux(&self, y: &[f64]) -> Vec<(f64, f64)> {
        let nuclear = self.joined.nuclear();
        let model = nuclear.feedback();
        let mut out = vec![(0., 0.); self.groups];
        for s in model.supports() {
            let n = self.value(y, s.region);
            let fissile =
                y[self.index(s.material, FISSILE)] * self.scales[self.index(s.material, FISSILE)];
            let g = s.production_reference_per_s * fissile
                / model.materials()[s.material].reference_fissile_atoms;
            out[s.material].0 += g * n;
            out[s.material].1 += s.exposure_per_population_s_m2 * n;
        }
        out
    }
    fn poisons(&self, y: &[f64], g: usize) -> [f64; 4] {
        std::array::from_fn(|k| {
            let i = self.index(g, POISON0 + k);
            y[i] * self.scales[i]
        })
    }
}

fn state_y(state: &Value, block: &Block, packet_path: &str) -> (Vec<f64>, Vec<f64>) {
    assert_eq!(
        state["packet"].as_str(),
        Some(packet_path),
        "the state is of the spine's packet"
    );
    let (y, yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    assert_eq!(
        y.len(),
        block.joined.dimension(),
        "the state is of the joined layout"
    );
    assert_eq!(yp.len(), y.len());
    (y, yp)
}

#[test]
#[ignore = "one call per state: LD01_POISON_STATE with LD01_POISON_FLUX_STATE to LD01_POISON_OUT"]
fn equilibrate_the_poisons() {
    let water = select_water();
    let (packet_path, packet_bytes) = common::packet_bytes();
    let packet: Value = serde_json::from_slice(&packet_bytes).expect("packet json");
    let (state_path, flux_path) = (env("LD01_POISON_STATE"), env("LD01_POISON_FLUX_STATE"));
    let (out, record_path) = (env("LD01_POISON_OUT"), env("LD01_POISON_RECORD"));
    for p in [&out, &record_path] {
        assert!(!std::path::Path::new(p).exists(), "{p}: never overwritten");
    }
    let block = Block::new();
    let law = Law::of(&packet);
    let model = law.model();
    let mut state = read(&state_path);
    let (mut y, mut yp) = state_y(&state, &block, &packet_path);
    let (flux_y, _) = state_y(&read(&flux_path), &block, &packet_path);
    let flux = block.flux(&flux_y);
    let mut groups = Vec::with_capacity(block.groups);
    let mut changed = Vec::new();
    for (g, &(f, phi)) in flux.iter().enumerate() {
        assert!(
            f > 0. && phi > 0.,
            "group {g}: fission rate {f}, exposure {phi}"
        );
        let before = block.poisons(&y, g);
        let eq = law.equilibrium(f, phi);
        let mut rate = [0.; 4];
        model
            .rates(&eq, law.input(f, phi), &mut rate)
            .unwrap_or_else(|e| panic!("{e}"));
        for k in 0..4 {
            let residual =
                (rate[k] / (law.decay.get(k).copied().unwrap_or(law.sigma_sm * phi) * eq[k])).abs();
            assert!(
                residual < 1e-12,
                "group {g} {}: relative residual {residual}",
                SPECIES[k]
            );
            let i = block.index(g, POISON0 + k);
            y[i] = eq[k] / block.scales[i];
            changed.push(i);
        }
        // yp: the law's rate at the new values and the target state's own
        // fission rate and exposure (zero when the two states are one).
        let own = block.flux(&y)[g];
        let mut at_own = [0.; 4];
        model
            .rates(&eq, law.input(own.0, own.1), &mut at_own)
            .unwrap_or_else(|e| panic!("{e}"));
        for k in 0..4 {
            let i = block.index(g, POISON0 + k);
            yp[i] = at_own[k] / block.scales[i];
        }
        groups.push(json!({"group": g, "fissions_per_s": f, "exposure_per_m2_s": phi,
            "before": before, "equilibrium": eq,
            "relative_change": SPECIES.iter().enumerate().map(|(k, s)| (s.to_string(), json!(eq[k] / before[k] - 1.))).collect::<serde_json::Map<_, _>>()}));
    }
    let record = json!({
        "rule": "R4-NUC-POISON-EQ: each replica group's I-135, Xe-135, Pm-149, Sm-149 set to the poison law's algebraic equilibrium at the flux state's own fission rate and exposure; every other coordinate's bits kept; yp of the four at the law's rate at the target state's own fission rate and exposure",
        "water": water, "packet": packet_path,
        "packet_sha256": common::provenance::sha256_file(&packet_path).expect("sha256"),
        "state": state_path, "state_sha256": common::provenance::sha256_file(&state_path).expect("sha256"),
        "flux_state": flux_path, "flux_state_sha256": common::provenance::sha256_file(&flux_path).expect("sha256"),
        "changed_coordinates": changed.len(), "groups": groups,
    });
    let old = from_bits(&state["y_bits"]);
    let kept = old
        .iter()
        .zip(&y)
        .enumerate()
        .filter(|(i, (a, b))| !changed.contains(i) && a.to_bits() != b.to_bits())
        .count();
    assert_eq!(kept, 0, "a coordinate outside the poisons moved");
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    state["y_bits"] = json!(bits(&y));
    state["yp_bits"] = json!(bits(&yp));
    state["poison_equilibrium"] = json!({"rule": record["rule"], "flux_state": flux_path,
        "flux_state_sha256": record["flux_state_sha256"], "from": state_path, "from_sha256": record["state_sha256"]});
    std::fs::write(&out, serde_json::to_vec(&state).unwrap()).unwrap();
    std::fs::write(&record_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    eprintln!(
        "poison equilibrium: {} coordinates set, written {out}",
        changed.len()
    );
}

#[test]
#[ignore = "one check per settled state: LD01_POISON_STATE to LD01_POISON_RECORD"]
fn check_the_poison_equilibrium() {
    let water = select_water();
    let (packet_path, packet_bytes) = common::packet_bytes();
    let packet: Value = serde_json::from_slice(&packet_bytes).expect("packet json");
    let (state_path, record_path) = (env("LD01_POISON_STATE"), env("LD01_POISON_RECORD"));
    assert!(
        !std::path::Path::new(&record_path).exists(),
        "never overwritten"
    );
    let wiki = env("LD01_WIKI_ROOT");
    let page = std::fs::read_to_string(format!("{wiki}/{PAGE}")).expect("the hot reference page");
    let open = "```ld01-poison-equilibrium\n";
    let mut found = page.match_indices(open).map(|(i, _)| i + open.len());
    let start = found.next().expect("no ld01-poison-equilibrium block");
    assert!(
        found.next().is_none(),
        "more than one ld01-poison-equilibrium block"
    );
    let text = &page[start..start + page[start..].find("\n```").expect("unterminated block")];
    let declared: Value = serde_json::from_str(text).expect("ld01-poison-equilibrium json");
    let tolerance = declared["relativeTolerance"]
        .as_f64()
        .expect("relativeTolerance");
    assert!(tolerance > 0. && tolerance.is_finite());
    let block = Block::new();
    let law = Law::of(&packet);
    let (y, _) = state_y(&read(&state_path), &block, &packet_path);
    let flux = block.flux(&y);
    let mut worst = [0f64; 4];
    let mut groups = Vec::new();
    for (g, &(f, phi)) in flux.iter().enumerate() {
        let (now, eq) = (block.poisons(&y, g), law.equilibrium(f, phi));
        let dev: [f64; 4] = std::array::from_fn(|k| now[k] / eq[k] - 1.);
        for k in 0..4 {
            worst[k] = worst[k].max(dev[k].abs());
        }
        groups.push(json!({"group": g, "fissions_per_s": f, "exposure_per_m2_s": phi, "relative_deviation": dev}));
    }
    let converged = worst.iter().all(|d| *d <= tolerance);
    let record = json!({
        "rule": "R4-NUC-POISON-EQ check: each group's four poisons against the poison law's equilibrium at the state's own fission rate and exposure; converged when every |relative deviation| is within the block's relativeTolerance",
        "block": declared, "block_sha256": leitbild_operating_plant::digest::sha256(text.as_bytes()),
        "water": water, "packet": packet_path, "state": state_path,
        "state_sha256": common::provenance::sha256_file(&state_path).expect("sha256"),
        "state_t_s": read(&state_path)["t_s"],
        "worst_relative_deviation": SPECIES.iter().zip(worst).map(|(s, d)| (s.to_string(), json!(d))).collect::<serde_json::Map<_, _>>(),
        "tolerance": tolerance, "converged": converged, "groups": groups,
    });
    std::fs::write(&record_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    eprintln!("poison check: worst {worst:?} against {tolerance}: converged {converged}");
}

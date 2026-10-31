//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#compact-operating-allocation-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/equipment.md#signed-high-pressure-service-machine
//! G1-C09 (S4 readiness package r2 §4.2): a TEST-ONLY standalone block of the
//! feed hydraulic train, evaluated at its prepared state. NEVER joined to the
//! spine and never a gate; the ELEC-slice pattern (own rows, an analytic
//! dense block, stock IDA only).
//!
//! Scope: FW.P1/P2 suction casings (M, U) and signed machines (rotor speed,
//! zero-storage stage and internal HEM restriction), FW.DISCHARGE, the four
//! heater tube stores (M, U) with their inlet ISO, fixed channel, outlet ISO
//! and bypass, FW.HEADER, and per SG the fixed/ISO path and the FCV (healthy
//! checks, forward flow). Held port inputs: the suction-link inflow and its
//! enthalpy (the link's impulse is an open G1.1 item), the casing metal
//! temperature (C12), motor support and speed request (C14), the wall heat
//! into each tube (C09's heater walls, outside this block), the SG feed-port
//! pressures (C08) and every valve opening (held stem trajectories).
//!
//! Laws, all from the compiled `feed` section (`reference-design-operating-
//! feed.ts`) and the runtime water owner (IF97 through `If97`):
//! - casing and tube EOS rows `M − rho(p, U/M)·V`; balances `M' = Σm`,
//!   `U' = Σ m·h + Q`;
//! - stage `dpE = (rho/rho0)·dp0·F·n·(1.25 n − k|q|)`, `h* = h(p*, s)` on the
//!   energy adiabat `dh/dp = 1/rho(p, h)` (the single property boundary has
//!   no entropy; RK4 on the nozzle path's 0.02 ln p grid), `m = CdA·G_HEM(p*,
//!   h*, p_D)` with the kernel's `restriction_flux`, `h_out = h* + Pmix/m`;
//! - rotor `J ω' = T_motor − T_exchange − T_mix − T_extra − T_drag` with the
//!   3 s tracking motor law, zero when unsupported;
//! - every series restriction is `m = a·CdA·G_HEM(p_up, h_up, p_dn)` with
//!   one signed (here forward) common flow and a solved intermediate
//!   pressure; zero-storage junctions mix by mass.
//! `F = 1` (water only, adequate NPSH at the prepared state) and the forward
//! quadrant are asserted at every evaluation; the check locks (class R) and
//! the reverse quadrant are outside this prototype.
//!
//! Run: `G1C09_FEED_SECTION=<compiled feed section JSON> [G1C09_RECEIPT=<out.json>]
//! cargo test --release --features ida --test g1_c09_feed_block -- --ignored --nocapture`
#![cfg(feature = "ida")]
use leitbild_operating_plant::{
    network::{
        Failure as Nf, Properties,
        properties::{Shared, inverse},
        stratified::restriction_flux,
    },
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, System},
};
use serde_json::{Value, json};

#[path = "common/cpu.rs"]
mod cpu;

type S = Scalar;
/// The nozzle path's `ln p` grid (`network::stratified`), reused for the stage.
const LOG_STEP: f64 = 0.02;
const N: usize = 67;
/// The feed path's differential coordinates are 0..14; the shell side's are 47..56.
const NDIFF: usize = 14;
const NPORTS: usize = 46;
fn is_differential(j: usize) -> bool {
    j < NDIFF || (47..56).contains(&j)
}
/// S4-D2 hook. Shell side: H2–H4 (heater index 1..=3). H1's shell (0.04975 MPa) and the
/// H2→H1 and H1→COND drains lie below the property boundary's 0.1 MPa floor.
const SHELLS: [usize; 3] = [1, 2, 3];

fn k(v: f64) -> S {
    S::new(v, 0.)
}
fn text(e: Nf) -> String {
    match e {
        Nf::Recoverable(s) | Nf::Fatal(s) => s,
    }
}
struct Liquid {
    rho: S,
    h: S,
    t: S,
}
fn liquid<P: Properties>(pr: &P, p: S, target: S, enthalpy: bool) -> Result<Liquid, String> {
    let (w, d) = inverse(pr, p, target, 0, enthalpy, None).map_err(text)?;
    Ok(Liquid {
        rho: S::new(w.density_kg_m3, d.density_kg_m3),
        h: S::new(w.enthalpy_j_kg, d.enthalpy_j_kg),
        t: S::new(w.temperature_k, d.temperature_k),
    })
}
/// `h(pb, s(pa, ha))` for a single-phase liquid stage, `pb >= pa`.
fn adiabat<P: Properties>(pr: &P, pa: S, ha: S, pb: S) -> Result<(S, usize), String> {
    // G1C09_STAGE_STEPS: the lead-decision candidate, a fixed number of RK4
    // steps over the stage instead of the nozzle path's grid.
    match std::env::var("G1C09_STAGE_STEPS").ok().and_then(|s| s.parse::<f64>().ok()) {
        Some(steps) => adiabat_on(pr, pa, ha, pb, (pb.value / pa.value).ln() / steps * (1. + 1e-12)),
        None => adiabat_on(pr, pa, ha, pb, LOG_STEP),
    }
}
fn adiabat_on<P: Properties>(pr: &P, pa: S, ha: S, pb: S, log_step: f64) -> Result<(S, usize), String> {
    if pb.value < pa.value {
        return Err(format!("stage adiabat runs upward: {} < {}", pb.value, pa.value));
    }
    let ratio = log_step.exp();
    let v = |p: S, h: S| -> Result<S, String> { Ok(k(1.) / liquid(pr, p, h, true)?.rho) };
    let (mut p, mut h, mut calls) = (pa, ha, 0);
    while p.value < pb.value {
        let next = if p.value * ratio < pb.value { p * k(ratio) } else { pb };
        let dp = next - p;
        let mid = (p + next) * k(0.5);
        let k1 = v(p, h)?;
        let k2 = v(mid, h + dp * k1 * k(0.5))?;
        let k3 = v(mid, h + dp * k2 * k(0.5))?;
        let k4 = v(next, h + dp * k3)?;
        h = h + dp * (k1 + k(2.) * k2 + k(2.) * k3 + k4) / k(6.);
        p = next;
        calls += 4;
    }
    Ok((h, calls))
}
fn flux<P: Properties>(pr: &P, p0: S, h0: S, pb: S) -> Result<S, String> {
    if pb.value > p0.value {
        return Err(format!("reverse restriction flow ({} > {}) is outside this prototype", pb.value, p0.value));
    }
    if std::env::var("G1C09_DROP_FORM").is_ok() {
        return flux_drop(pr, p0, h0, pb);
    }
    let f = restriction_flux(pr, false, p0, h0, pb).map_err(text)?;
    if f.choked {
        return Err("choked restriction is outside this prototype".into());
    }
    Ok(f.mass_flux)
}
/// A drain or extraction restriction: the same law, liquid or vapor donor,
/// choking allowed (a choked flux does not read the receiver).
fn flux_phase<P: Properties>(pr: &P, vapor: bool, p0: S, h0: S, pb: S) -> Result<S, String> {
    if pb.value > p0.value {
        return Err(format!("reverse restriction flow ({} > {}) is outside this prototype", pb.value, p0.value));
    }
    Ok(restriction_flux(pr, vapor, p0, h0, pb).map_err(text)?.mass_flux)
}
/// DEMONSTRATION ONLY (G1C09_DROP_FORM): the kernel's unchoked liquid
/// restriction on the same RK4 `ln p` grid, accumulating the drop
/// `Δh = ∫v dp` from zero instead of forming `h0 − h`; `G = sqrt(2 Δh)/v`
/// at the back pressure, where the unchoked maximum lies. Not a kernel change.
fn flux_drop<P: Properties>(pr: &P, p0: S, h0: S, pb: S) -> Result<S, String> {
    if pb.value == p0.value {
        return Ok(k(0.));
    }
    let ratio = (-LOG_STEP).exp();
    let v = |p: S, dh: S| -> Result<S, String> { Ok(k(1.) / liquid(pr, p, h0 - dh, true)?.rho) };
    let (mut p, mut dh) = (p0, k(0.));
    while p.value > pb.value {
        let next = if p.value * ratio > pb.value { p * k(ratio) } else { pb };
        let dp = p - next;
        let mid = (p + next) * k(0.5);
        let k1 = v(p, dh)?;
        let k2 = v(mid, dh + dp * k1 * k(0.5))?;
        let k3 = v(mid, dh + dp * k2 * k(0.5))?;
        let k4 = v(next, dh + dp * k3)?;
        dh = dh + dp * (k1 + k(2.) * k2 + k(2.) * k3 + k4) / k(6.);
        p = next;
    }
    let root = (2. * dh.value).sqrt();
    Ok(S::new(root, dh.direction / root) / v(pb, dh)?)
}
fn forward(p: f64, t: f64) -> leitbild_operating_plant::network::Water {
    If97.forward(false, p, t).expect("prepared liquid state")
}

#[derive(Clone, Debug)]
struct Pump {
    m0: f64,
    rho0: f64,
    q0: f64,
    dp0: f64,
    p_in0: f64,
    h_in0: f64,
    omega0: f64,
    cross: f64,
    shut: f64,
    cda: f64,
    mix: f64,
    p0: f64,
    inertia: f64,
    v_case: f64,
    g_case: f64,
    drag: f64,
    churn: f64,
    limit: f64,
    tracking: f64,
    calibration: Value,
}
#[derive(Clone, Debug)]
struct Heater {
    cda_in: f64,
    cda_ch: f64,
    cda_out: f64,
    cda_byp: f64,
    v: f64,
    h_ref_in: f64,
    h_ref_out: f64,
    p_ref: f64,
    t_ref: f64,
}
#[derive(Clone, Debug)]
struct Shell {
    v: f64,
    c_wall: f64,
    g_shell: f64,
    g_tube: f64,
    cda_ext: f64,
    cda_drain: f64,
    p0: f64,
    vl0: f64,
    tw0: f64,
    m_ext0: f64,
    m_drain0: f64,
    donor: (f64, f64),
}
#[derive(Clone, Debug)]
struct Block {
    pump: Pump,
    heaters: Vec<Heater>,
    junction: Vec<f64>,
    cda_iso: f64,
    cda_fcv: f64,
    h_feed0: f64,
    m_tot: f64,
    shells: Vec<Shell>,
    sizing: Value,
}
#[derive(Clone, Debug)]
struct Ports {
    m_s: [f64; 2],
    h_s: [f64; 2],
    t_metal: [f64; 2],
    supported: [bool; 2],
    omega_req: [f64; 2],
    q: [f64; 4],
    p_sg: [f64; 2],
    a_in: [f64; 4],
    a_out: [f64; 4],
    a_byp: [f64; 4],
    a_iso: [f64; 2],
    u_fcv: [f64; 2],
    ext_donor_p: [f64; 3],
    ext_donor_h: [f64; 3],
    sep: (f64, f64),
    rh: (f64, f64),
    h2_drain_out: f64,
    a_ext: [f64; 3],
    u_drain: [f64; 2],
    /// S4-D6 preparation: the FCV openings become unknowns and each branch
    /// delivers its SG's steam flow (coordinates N and N+1, rows N and N+1).
    fcv_target: Option<[f64; 2]>,
    /// Prototype stand-in for transients only: the casing is inert and the
    /// stage draws tank liquid at the held suction state (`p_eye`, `h_s`),
    /// because the suction link's impulse is the open G1.1 item.
    suction_held: Option<[f64; 2]>,
}
const PORT_NAMES: [&str; NPORTS] = [
    "m_s.P1", "m_s.P2", "h_s.P1", "h_s.P2", "T_metal.P1", "T_metal.P2", "omega_req.P1", "omega_req.P2",
    "Q_wall.H1", "Q_wall.H2", "Q_wall.H3", "Q_wall.H4", "p_SG.A", "p_SG.B", "a_inISO.H1", "a_inISO.H2",
    "a_inISO.H3", "a_inISO.H4", "a_outISO.H1", "a_outISO.H2", "a_outISO.H3", "a_outISO.H4", "a_bypass.H1",
    "a_bypass.H2", "a_bypass.H3", "a_bypass.H4", "a_ISO.A", "a_ISO.B", "u_FCV.A", "u_FCV.B",
    "p_extDonor.H2(LP1)", "p_extDonor.H3(SEP)", "p_extDonor.H4(HP2)", "h_extDonor.H2", "h_extDonor.H3", "h_extDonor.H4",
    "m_SEP.liquid→H2", "h_SEP.liquid", "m_RH.condensate→H4", "h_RH.condensate", "m_drain.H2→H1", "a_extISO.H2",
    "a_extISO.H3", "a_extISO.H4", "u_drain.H4", "u_drain.H3",
];
const COORD_NAMES: [&str; N] = [
    "M_case.P1", "U_case.P1", "M_case.P2", "U_case.P2", "omega.P1", "omega.P2", "M_tube.H1", "U_tube.H1",
    "M_tube.H2", "U_tube.H2", "M_tube.H3", "U_tube.H3", "M_tube.H4", "U_tube.H4", "p_case.P1", "p_case.P2",
    "m.P1", "m.P2", "p.DISCHARGE", "p_tube.H1", "m_in.H1", "m_out.H1", "p_mid.H1", "m_byp.H1", "p_tube.H2",
    "m_in.H2", "m_out.H2", "p_mid.H2", "m_byp.H2", "p_tube.H3", "m_in.H3", "m_out.H3", "p_mid.H3", "m_byp.H3",
    "p_tube.H4", "m_in.H4", "m_out.H4", "p_mid.H4", "m_byp.H4", "p.J1", "p.J2", "p.J3", "p.HEADER", "m.A",
    "p_mid.A", "m.B", "p_mid.B", "M_shell.H2", "U_shell.H2", "M_shell.H3", "U_shell.H3", "M_shell.H4", "U_shell.H4",
    "E_wall.H2", "E_wall.H3", "E_wall.H4", "p_shell.H2", "V_l.H2", "p_shell.H3", "V_l.H3", "p_shell.H4", "V_l.H4",
    "m_ext.H2", "m_ext.H3", "m_ext.H4", "m_drain.H4→H3", "m_drain.H3→H2",
];
impl Ports {
    fn get(&self, id: usize) -> f64 {
        match id {
            0 | 1 => self.m_s[id],
            2 | 3 => self.h_s[id - 2],
            4 | 5 => self.t_metal[id - 4],
            6 | 7 => self.omega_req[id - 6],
            8..=11 => self.q[id - 8],
            12 | 13 => self.p_sg[id - 12],
            14..=17 => self.a_in[id - 14],
            18..=21 => self.a_out[id - 18],
            22..=25 => self.a_byp[id - 22],
            26 | 27 => self.a_iso[id - 26],
            28 | 29 => self.u_fcv[id - 28],
            30..=32 => self.ext_donor_p[id - 30],
            33..=35 => self.ext_donor_h[id - 33],
            36 => self.sep.0,
            37 => self.sep.1,
            38 => self.rh.0,
            39 => self.rh.1,
            40 => self.h2_drain_out,
            41..=43 => self.a_ext[id - 41],
            _ => self.u_drain[id - 44],
        }
    }
}
/// Differential coefficient of each row's own y' (1 for M/U rows, J for the rotors).
fn yp_coefficient(b: &Block, row: usize) -> f64 {
    match row {
        4 | 5 => b.pump.inertia,
        r if is_differential(r) => 1.,
        _ => 0.,
    }
}

impl Block {
    fn new(section: &Value) -> Self {
        let f = |v: &Value, key: &str| v[key].as_f64().unwrap_or_else(|| panic!("feed section: {key}"));
        let fp = &section["feedPump"];
        let m0 = f(fp, "flow_kg_s");
        let p_in0 = f(&fp["reference"], "inletPressure_Pa");
        let t_in0 = f(&fp["reference"], "inletTemperature_K");
        let p_out0 = f(&fp["reference"], "outletPressure_Pa");
        let eta = f(fp, "hydraulicEfficiency");
        let cross = f(fp, "crossCoefficient");
        let shut = f(fp, "shutoffHeadRatio");
        let omega0 = f(fp, "omega0_rad_s");
        let w_in = forward(p_in0, t_in0);
        let (rho0, h_in0) = (w_in.density_kg_m3, w_in.enthalpy_j_kg);
        let q0 = m0 / rho0;
        let dp0 = p_out0 - p_in0;
        let (h_s_out0, _) = adiabat(&If97, k(p_in0), k(h_in0), k(p_out0)).unwrap();
        let p0 = m0 * (h_s_out0.value - h_in0) / eta;
        let p_star0 = p_in0 + (shut - cross) * dp0;
        let (h_star0, _) = adiabat(&If97, k(p_in0), k(h_in0), k(p_star0)).unwrap();
        let cda = m0 / flux(&If97, k(p_star0), h_star0, k(p_out0)).unwrap().value;
        let mix = p0 - m0 * (h_star0.value - h_in0);
        assert!(mix >= 0., "H0 must be nonnegative before admitting the selection");
        let drag = f(fp, "dragFraction");
        let inertia = (p0 + drag * p0) * f(fp, "coastdownScale_s") / (omega0 * omega0);
        let pump = Pump {
            m0,
            rho0,
            q0,
            dp0,
            p_in0,
            h_in0,
            omega0,
            cross,
            shut,
            cda,
            mix,
            p0,
            inertia,
            v_case: f(fp, "caseResidence_s") * q0,
            g_case: f(fp, "caseConductance_W_K"),
            drag,
            churn: f(fp, "churnFloorFraction"),
            limit: f(fp, "torqueLimit") * (1. + drag) * p0 / omega0,
            tracking: f(fp, "torqueTracking_s"),
            calibration: json!({
                "rho0_kg_m3": rho0, "h_in0_J_kg": h_in0, "isentropicRise_J_kg": h_s_out0.value - h_in0,
                "P0_W": p0, "pStar0_Pa": p_star0, "hStar0_J_kg": h_star0.value, "cdaInternal_m2": cda,
                "H0_W": mix, "inertia_kg_m2": inertia, "caseVolume_m3": f(fp, "caseResidence_s") * q0,
                "wiki_HEOS": {"cdaInternal_m2": 0.0175632884, "H0_W": 603721.399, "P0_W": 7526396.0, "pStar0_Pa": 8494801.0},
            }),
        };
        let hs = &section["heaters"];
        let arr = |v: &Value| -> Vec<f64> { v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect() };
        let junction = arr(&hs["junctionPressure_Pa"]);
        let tube_p = arr(&hs["tubePressure_Pa"]);
        let tube_t = arr(&hs["tubeOutlet_K"]);
        let loss = &hs["lossAllocation_Pa"];
        let (l_in, l_ch, l_out) = (f(loss, "inletIso"), f(loss, "channel"), f(loss, "outletIso"));
        let m_tot = f(&section["condensatePump"], "flow_kg_s");
        let mut h_ref_in = h_in0 + p0 / m0; // the feed-pump sizing outlet
        let mut heaters = Vec::new();
        for i in 0..4 {
            let (up, dn, pt) = (junction[i], junction[i + 1], tube_p[i]);
            assert!((up - l_in - pt).abs() < 1e-6 && (pt - l_ch - l_out - dn).abs() < 1e-6, "tube allocation");
            let h_out = forward(pt, tube_t[i]).enthalpy_j_kg;
            let cda_in = m_tot / flux(&If97, k(up), k(h_ref_in), k(pt)).unwrap().value;
            let cda_ch = m_tot / flux(&If97, k(pt), k(h_out), k(pt - l_ch)).unwrap().value;
            let cda_out = m_tot / flux(&If97, k(pt - l_ch), k(h_out), k(dn)).unwrap().value;
            let cda_byp = m_tot / flux(&If97, k(up), k(h_ref_in), k(dn)).unwrap().value;
            heaters.push(Heater {
                cda_in,
                cda_ch,
                cda_out,
                cda_byp,
                v: f(hs, "tubeVolume_m3"),
                h_ref_in,
                h_ref_out: h_out,
                p_ref: pt,
                t_ref: tube_t[i],
            });
            h_ref_in = h_out;
        }
        let br = &section["branches"];
        let h_feed0 = forward(f(br, "headerPressure_Pa"), f(br, "feedTemperature_K")).enthalpy_j_kg;
        let cda_iso = m0 / flux(&If97, k(f(br, "headerPressure_Pa")), k(h_feed0), k(f(br, "isoOutletPressure_Pa"))).unwrap().value;
        let cda_fcv = m0
            / (f(br, "fcvReferenceOpening")
                * flux(&If97, k(f(br, "isoOutletPressure_Pa")), k(h_feed0), k(f(br, "sgReferencePressure_Pa"))).unwrap().value);
        // Shell side, from the heater block and the cycle's sizing flows.
        let sizing = section["heaterSizing"].clone();
        assert!(sizing.is_object(), "feed section compiled without the cycle's heater sizing (research python)");
        let ext_p = arr(&hs["extractionPressure_Pa"]);
        let shell_v = arr(&hs["shellVolume_m3"]);
        let wall_c = arr(&hs["wallCapacity_J_K"]);
        let fraction = f(hs, "shellPressureFraction");
        let liquid0 = f(hs, "initialLiquidFraction");
        let mid = f(hs, "wallMidpointFraction");
        let drain_open = f(&hs["drain"], "sizingOpening");
        let ext_flow = arr(&sizing["extraction_kg_s"]);
        let drain_flow = arr(&sizing["drainOut_kg_s"]);
        let sat = |p: f64| If97.saturation(k(p)).expect("prepared saturation");
        let mut shells = Vec::new();
        for i in SHELLS {
            let p0 = fraction * ext_p[i];
            let s0 = sat(p0);
            let t_sat = s0.temperature.value;
            let q = m_tot * (heaters[i].h_ref_out - heaters[i].h_ref_in);
            let tw0 = t_sat + mid * (heaters[i].t_ref - t_sat);
            let donor = match i {
                2 => (ext_p[i], sat(ext_p[i]).vapor.enthalpy.value), // saturated separator vapor
                _ => {
                    let d = &sizing["donor"][i];
                    (f(d, "pressure_Pa"), f(d, "enthalpy_J_kg"))
                }
            };
            let cda_ext = ext_flow[i] / flux_phase(&If97, true, k(donor.0), k(donor.1), k(p0)).unwrap().value;
            // Drains H4→H3 and H3→H2 (H2→H1 is held: its receiver lies below the domain floor).
            let cda_drain = if i >= 2 {
                let receiver = fraction * ext_p[i - 1];
                drain_flow[i] / (drain_open * flux_phase(&If97, false, k(p0), s0.liquid.enthalpy, k(receiver)).unwrap().value)
            } else {
                0.
            };
            shells.push(Shell {
                v: shell_v[i],
                c_wall: wall_c[i],
                g_shell: q / (t_sat - tw0),
                g_tube: q / (tw0 - heaters[i].t_ref),
                cda_ext,
                cda_drain,
                p0,
                vl0: liquid0 * shell_v[i],
                tw0,
                m_ext0: ext_flow[i],
                m_drain0: drain_flow[i],
                donor,
            });
        }
        Self { pump, heaters, junction, cda_iso, cda_fcv, h_feed0, m_tot, shells, sizing }
    }

    /// Prepared differential state and reference guesses for the algebraic state.
    fn prepared(&self) -> Vec<f64> {
        let mut y = vec![0.; N];
        let p = &self.pump;
        let w = forward(p.p_in0, 313.15);
        for i in 0..2 {
            let m = w.density_kg_m3 * p.v_case;
            y[2 * i] = m;
            y[2 * i + 1] = m * w.internal_energy_j_kg;
            y[4 + i] = p.omega0;
            y[14 + i] = p.p_in0;
            y[16 + i] = p.m0;
        }
        y[18] = self.junction[0];
        for (i, h) in self.heaters.iter().enumerate() {
            let wt = forward(h.p_ref, h.t_ref);
            y[6 + 2 * i] = wt.density_kg_m3 * h.v;
            y[7 + 2 * i] = y[6 + 2 * i] * wt.internal_energy_j_kg;
            let b = 19 + 5 * i;
            y[b] = h.p_ref;
            y[b + 1] = self.m_tot;
            y[b + 2] = self.m_tot;
            y[b + 3] = self.junction[i + 1] + 5e3;
            y[b + 4] = 0.;
        }
        for i in 0..3 {
            y[39 + i] = self.junction[i + 1];
        }
        y[42] = self.junction[4];
        y[43] = p.m0;
        y[44] = 7.0e6;
        y[45] = p.m0;
        y[46] = 7.0e6;
        for (s, sh) in self.shells.iter().enumerate() {
            let sat = If97.saturation(k(sh.p0)).unwrap();
            let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
            let (uf, ug) = (sat.liquid.enthalpy.value - sh.p0 / rf, sat.vapor.enthalpy.value - sh.p0 / rg);
            y[47 + 2 * s] = sh.vl0 * rf + (sh.v - sh.vl0) * rg;
            y[48 + 2 * s] = sh.vl0 * rf * uf + (sh.v - sh.vl0) * rg * ug;
            y[53 + s] = sh.c_wall * (sh.tw0 - 273.15);
            y[56 + 2 * s] = sh.p0;
            y[57 + 2 * s] = sh.vl0;
            y[62 + s] = sh.m_ext0;
        }
        y[65] = self.shells[2].m_drain0;
        y[66] = self.shells[1].m_drain0;
        y
    }
    fn prepared_ports(&self, p_sg: f64) -> Ports {
        let p = &self.pump;
        let f = |v: &Value, key: &str| v[key].as_f64().unwrap();
        Ports {
            m_s: [p.m0; 2],
            h_s: [p.h_in0; 2],
            t_metal: [313.15; 2],
            supported: [true; 2],
            omega_req: [p.omega0; 2],
            q: std::array::from_fn(|i| self.m_tot * (self.heaters[i].h_ref_out - self.heaters[i].h_ref_in)),
            p_sg: [p_sg; 2],
            a_in: [1.; 4],
            a_out: [1.; 4],
            a_byp: [0.; 4],
            a_iso: [1.; 2],
            u_fcv: [0.7; 2],
            ext_donor_p: std::array::from_fn(|s| self.shells[s].donor.0),
            ext_donor_h: std::array::from_fn(|s| self.shells[s].donor.1),
            sep: (f(&self.sizing, "separatorLiquid_kg_s"), If97.saturation(k(0.8e6)).unwrap().liquid.enthalpy.value),
            // The RH heating shell's prepared 0.995 × 5.98 MPa saturated liquid (C10's face).
            rh: (f(&self.sizing, "rhCondensate_kg_s"), If97.saturation(k(0.995 * 5.98e6)).unwrap().liquid.enthalpy.value),
            h2_drain_out: self.shells[0].m_drain0,
            a_ext: [1.; 3],
            u_drain: [0.5; 2],
            fcv_target: None,
            suction_held: None,
        }
    }

    /// Rows of `F(y, y') = 0` in physical units; `seed` gives each coordinate's
    /// direction, `pseed` one port's. Row r belongs to coordinate r.
    fn eval<P: Properties>(
        &self,
        pr: &P,
        y: &[f64],
        yp: &[f64],
        ports: &Ports,
        seed: Option<usize>,
        pseed: Option<usize>,
        calls: &mut usize,
    ) -> Result<Vec<S>, String> {
        let n = y.len();
        let ys: Vec<S> = (0..n).map(|j| S::new(y[j], if seed == Some(j) { 1. } else { 0. })).collect();
        let port = |id: usize| S::new(ports.get(id), if pseed == Some(id) { 1. } else { 0. });
        let mut r = vec![k(0.); n];
        let pm = &self.pump;
        let p_d = ys[18];
        let mut h_recv = [k(0.); 2];
        for i in 0..2 {
            let (m_c, u_c, omega, p_c, m_p) = (ys[2 * i], ys[2 * i + 1], ys[4 + i], ys[14 + i], ys[16 + i]);
            if !(m_p.value > 0. && omega.value > 0.) {
                return Err(format!("pump {} left the forward quadrant (m {}, omega {})", i + 1, m_p.value, omega.value));
            }
            let c = match ports.suction_held {
                None => {
                    let c = liquid(pr, p_c, u_c / m_c, false)?;
                    r[14 + i] = m_c - c.rho * k(pm.v_case);
                    c
                }
                Some(p_eye) => {
                    r[14 + i] = p_c - k(p_eye[i]);
                    liquid(pr, p_c, port(2 + i), true)?
                }
            };
            let n = omega / k(pm.omega0);
            let q = m_p / (c.rho * k(pm.q0));
            let dens = c.rho / k(pm.rho0);
            // F = 1: adequate NPSH and no gas (asserted below for the casing state).
            // S4-D2 hook. F = 1. NPSHa needs p_v(T_case) = psat(40 °C) = 7.38 kPa, below the
            // maintained boundary's 0.1 MPa floor (tests/g1_c09_domain_probe.rs):
            // the factor cannot be evaluated through it (G1.1 blocker). The
            // feed-pool receipt's 9.654367 m NPSHa against 5 m NPSHr at the
            // nominal state is the basis for F = 1 at this prepared state.
            let dpe = dens * k(pm.dp0) * n * (k(pm.shut) * n - k(pm.cross) * q);
            let p_star = p_c + dpe;
            let (h_star, used) = adiabat(pr, p_c, c.h, p_star)?;
            *calls += used;
            let g = flux(pr, p_star, h_star, p_d)?;
            r[16 + i] = m_p - k(pm.cda) * g;
            let p_mix = k(pm.mix) * dens * n * n * q;
            h_recv[i] = h_star + p_mix / m_p;
            let t_ex = k(pm.dp0 / pm.omega0) * dens * m_p * (k(pm.shut) * n - k(pm.cross) * q) * ((h_star - c.h) / dpe);
            let t_mix = k(pm.mix / (pm.omega0 * pm.omega0)) * dens * omega * q;
            let floor = k(pm.churn * pm.p0) * dens * n * n * n;
            let p_extra = if floor.value - p_mix.value > 0. { floor - p_mix } else { k(0.) };
            let t_extra = p_extra / omega;
            let t_drag = k(pm.drag * pm.p0 / (pm.omega0 * pm.omega0)) * omega;
            let load = t_ex + t_mix + t_extra + t_drag;
            let t_motor = if ports.supported[i] {
                let demand = load + k(pm.inertia / pm.tracking) * (port(6 + i) - omega);
                if demand.value < 0. {
                    k(0.)
                } else if demand.value > pm.limit {
                    k(pm.limit)
                } else {
                    demand
                }
            } else {
                k(0.)
            };
            r[4 + i] = k(pm.inertia * yp[4 + i]) - (t_motor - load);
            // Liquid fraction 1: the extra heat and the reciprocal metal contact enter the casing water.
            let q_case = p_extra + k(pm.g_case) * (port(4 + i) - c.t);
            if ports.suction_held.is_some() {
                r[2 * i] = k(yp[2 * i]);
                r[2 * i + 1] = k(yp[2 * i + 1]);
            } else {
                r[2 * i] = k(yp[2 * i]) - (port(i) - m_p);
                r[2 * i + 1] = k(yp[2 * i + 1]) - (port(i) * port(2 + i) - m_p * c.h + q_case);
            }
        }
        // FW.DISCHARGE, zero storage: mass balance and mixed outgoing enthalpy.
        let m_d = ys[16] + ys[17];
        let mut h_up = (ys[16] * h_recv[0] + ys[17] * h_recv[1]) / m_d;
        let mut p_up = p_d;
        let mut upstream_row = 18;
        let mut tube_t = [k(0.); 3];
        r[18] = m_d;
        for (i, h) in self.heaters.iter().enumerate() {
            let b = 19 + 5 * i;
            let (m_t, u_t) = (ys[6 + 2 * i], ys[7 + 2 * i]);
            let (p_t, m_in, m_out, p_mid, m_byp) = (ys[b], ys[b + 1], ys[b + 2], ys[b + 3], ys[b + 4]);
            let p_dn = ys[if i < 3 { 39 + i } else { 42 }];
            let t = liquid(pr, p_t, u_t / m_t, false)?;
            r[b] = m_t - t.rho * k(h.v);
            r[b + 1] = m_in - port(14 + i) * k(h.cda_in) * flux(pr, p_up, h_up, p_t)?;
            r[b + 2] = m_out - k(h.cda_ch) * flux(pr, p_t, t.h, p_mid)?;
            r[b + 3] = m_out - port(18 + i) * k(h.cda_out) * flux(pr, p_mid, t.h, p_dn)?;
            r[b + 4] = if ports.a_byp[i] > 0. {
                m_byp - port(22 + i) * k(h.cda_byp) * flux(pr, p_up, h_up, p_dn)?
            } else {
                m_byp // a closed valve's identity
            };
            r[upstream_row] = r[upstream_row] - m_in - m_byp;
            r[6 + 2 * i] = k(yp[6 + 2 * i]) - (m_in - m_out);
            let q_tube = if i == 0 {
                port(8)
            } else {
                let sh = &self.shells[i - 1];
                let t_wall = ys[53 + i - 1] / k(sh.c_wall) + k(273.15);
                tube_t[i - 1] = t.t;
                k(sh.g_tube) * (t_wall - t.t)
            };
            r[7 + 2 * i] = k(yp[7 + 2 * i]) - (m_in * h_up - m_out * t.h + q_tube);
            let row = if i < 3 { 39 + i } else { 42 };
            r[row] = m_out + m_byp;
            h_up = (m_out * t.h + m_byp * h_up) / (m_out + m_byp);
            p_up = p_dn;
            upstream_row = row;
        }
        // FW.HEADER → per SG: fixed/ISO path, then FCV to the SG feed port.
        for s in 0..2 {
            let (m, p_mid) = (ys[43 + 2 * s], ys[44 + 2 * s]);
            r[42] = r[42] - m;
            r[43 + 2 * s] = m - port(26 + s) * k(self.cda_iso) * flux(pr, p_up, h_up, p_mid)?;
            let u = if n > N { ys[N + s] } else { port(28 + s) };
            r[44 + 2 * s] = m - u * k(self.cda_fcv) * flux(pr, p_mid, h_up, port(12 + s))?;
            if let Some(target) = ports.fcv_target {
                r[N + s] = m - k(target[s]);
            }
        }
        // Shell side H2–H4: saturated chart, wall, extraction and drains.
        let sats: Vec<_> = (0..3).map(|s| pr.saturation(ys[56 + 2 * s])).collect::<Result<_, _>>()?;
        for (s, sh) in self.shells.iter().enumerate() {
            let (m_sh, u_sh, e_w, p_sh, vl) = (ys[47 + 2 * s], ys[48 + 2 * s], ys[53 + s], ys[56 + 2 * s], ys[57 + 2 * s]);
            let sat = &sats[s];
            if !(vl.value > 0.05 * sh.v && vl.value < sh.v) {
                return Err(format!("shell H{} liquid {} m3 left the covered drain range", s + 2, vl.value));
            }
            let (rf, rg, hf, hg) = (sat.liquid.density, sat.vapor.density, sat.liquid.enthalpy, sat.vapor.enthalpy);
            let (uf, ug) = (hf - p_sh / rf, hg - p_sh / rg);
            r[56 + 2 * s] = m_sh - (vl * rf + (k(sh.v) - vl) * rg);
            r[57 + 2 * s] = u_sh - (vl * rf * uf + (k(sh.v) - vl) * rg * ug);
            let t_wall = e_w / k(sh.c_wall) + k(273.15);
            let q_shell = k(sh.g_shell) * (sat.temperature - t_wall);
            let q_tube = k(sh.g_tube) * (t_wall - tube_t[s]);
            r[53 + s] = k(yp[53 + s]) - (q_shell - q_tube);
            let m_ext = ys[62 + s];
            r[62 + s] = m_ext - port(41 + s) * k(sh.cda_ext) * flux_phase(pr, true, port(30 + s), port(33 + s), p_sh)?;
            // Drain in from the shell above (H4 has none; it receives RH condensate), out to the one below.
            let (m_in, h_in) = match s {
                0 => (ys[66], sats[1].liquid.enthalpy),
                1 => (ys[65], sats[2].liquid.enthalpy),
                _ => (k(0.), k(0.)),
            };
            let m_out = match s {
                0 => port(40),
                1 => ys[66],
                _ => ys[65],
            };
            let (m_c10, h_c10) = match s {
                0 => (port(36), port(37)),
                2 => (port(38), port(39)),
                _ => (k(0.), k(0.)),
            };
            r[47 + 2 * s] = k(yp[47 + 2 * s]) - (m_ext + m_in + m_c10 - m_out);
            r[48 + 2 * s] = k(yp[48 + 2 * s]) - (m_ext * port(33 + s) + m_in * h_in + m_c10 * h_c10 - m_out * hf - q_shell);
        }
        // Drains H4→H3 (row 65) and H3→H2 (row 66) are HELD at their sizing
        // flows here: the kernel's restriction_flux refuses every seeded
        // evaluation from a saturated-liquid donor at its own endpoint (the
        // liquid inverse's direction is Domain there; tests/g1_c09_domain_probe.rs,
        // 123 of 123 seeded refused, 0 of 123 value-only), so no Jacobian of a
        // drain row can be formed. A KERN finding; the law and its calibrated
        // area stay in this block for when it is fixed.
        // The rebuilt water library (adapter 10252c28) admits the 3.98 MPa
        // donor (H4→H3); below its 2 MPa metastable band the 0.796 MPa donor
        // (H3→H2) still refuses, so that drain stays held (S4-D2 hook: the
        // low-pressure domain decision or the band reopens it).
        let all = std::env::var("G1C09_DRAIN_LAW").is_ok();
        for (row, donor, receiver, u) in [(65, 2, 1, 44), (66, 1, 0, 45)] {
            let sh = &self.shells[donor];
            r[row] = if row == 65 || all {
                ys[row] - port(u) * k(sh.cda_drain) * flux_phase(pr, false, ys[56 + 2 * donor], sats[donor].liquid.enthalpy, ys[56 + 2 * receiver])?
            } else {
                ys[row] - k(sh.m_drain0)
            };
        }
        Ok(r)
    }
    fn values(&self, y: &[f64], yp: &[f64], ports: &Ports) -> Result<Vec<f64>, String> {
        let mut calls = 0;
        Ok(self.eval(&If97, y, yp, ports, None, None, &mut calls)?.iter().map(|s| s.value).collect())
    }
    /// Dense `∂F/∂y` by seeded directions through the same laws (column major).
    fn partials(&self, y: &[f64], yp: &[f64], ports: &Ports) -> Result<Vec<Vec<f64>>, String> {
        let shared = Shared::new(&If97);
        let mut calls = 0;
        (0..y.len())
            .map(|j| Ok(self.eval(&shared, y, yp, ports, Some(j), None, &mut calls)?.iter().map(|s| s.direction).collect()))
            .collect()
    }
    fn port_partials(&self, y: &[f64], yp: &[f64], ports: &Ports, id: usize) -> Result<Vec<f64>, String> {
        let mut calls = 0;
        Ok(self.eval(&If97, y, yp, ports, None, Some(id), &mut calls)?.iter().map(|s| s.direction).collect())
    }
    /// Row scales: kg/s, W, kg and N·m.
    fn row_scales(&self, y0: &[f64]) -> Vec<f64> {
        let (m0, e) = (self.pump.m0, self.pump.m0 * self.h_feed0);
        (0..y0.len())
            .map(|r| match r {
                0 | 2 | 6 | 8 | 10 | 12 => m0,
                1 | 3 | 7 | 9 | 11 | 13 => e,
                4 | 5 => self.pump.p0 / self.pump.omega0,
                14 | 15 => y0[2 * (r - 14)],
                b if (19..39).contains(&b) && (b - 19) % 5 == 0 => y0[6 + 2 * ((b - 19) / 5)],
                47 | 49 | 51 => m0,
                48 | 50 | 52 | 53 | 54 | 55 => e,
                56 | 58 | 60 => y0[47 + (r - 56)],
                57 | 59 | 61 => y0[48 + (r - 57)].abs(),
                _ => m0,
            })
            .collect()
    }
}

struct Sys {
    n: usize,
    block: Block,
    ports: Ports,
    root_p1_fraction: Option<f64>,
    residuals: usize,
    jacobians: usize,
}
fn fail(e: String) -> Failure {
    Failure::Recoverable(e)
}
impl System for Sys {
    /// Unreduced: every coordinate stands for itself (E-NUC).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    fn dimension(&self) -> usize {
        self.n
    }
    fn nonzeros(&self) -> usize {
        self.n * self.n
    }
    fn root_count(&self) -> usize {
        usize::from(self.root_p1_fraction.is_some())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.residuals += 1;
        out.copy_from_slice(&self.block.values(y, yp, &self.ports).map_err(fail)?);
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.jacobians += 1;
        let columns = self.block.partials(y, yp, &self.ports).map_err(fail)?;
        let n = self.n;
        for (j, column) in columns.iter().enumerate() {
            pointers[j] = (j * n) as i64;
            for (r, value) in column.iter().enumerate() {
                rows[j * n + r] = r as i64;
                data[j * n + r] = value + if r == j { cj * yp_coefficient(&self.block, r) } else { 0. };
            }
        }
        pointers[n] = (n * n) as i64;
        Ok(())
    }
    fn roots(&mut self, _: f64, y: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if let Some(fraction) = self.root_p1_fraction {
            out[0] = y[16] - fraction * self.block.pump.m0;
        }
        Ok(())
    }
}
fn differential(n: usize) -> Vec<f64> {
    (0..n).map(|j| if is_differential(j) { 1. } else { 0. }).collect()
}
fn tolerances(y0: &[f64]) -> Vec<f64> {
    y0.iter().enumerate().map(|(j, y)| 1e-10 * y.abs().max(if is_differential(j) { 1. } else { 1e3 })).collect()
}
/// Stock IDACalcIC (twice: the second pass starts from the first's state).
fn consistent(block: &Block, ports: &Ports, y: &mut [f64], yp: &mut [f64]) -> Result<(), String> {
    for _ in 0..2 {
        let atol = tolerances(y);
        let mut ida = Ida::new(
            Sys { n: y.len(), block: block.clone(), ports: ports.clone(), root_p1_fraction: None, residuals: 0, jacobians: 0 },
            Initial { time: 0., y, yp, differential: &differential(y.len()), absolute_tolerance: &atol, relative_tolerance: 1e-10 },
        )?;
        ida.initialize(1e-3, y, yp)?;
    }
    Ok(())
}
fn scaled_max(block: &Block, y0: &[f64], rows: &[f64]) -> (f64, usize) {
    let scales = block.row_scales(y0);
    rows.iter().zip(&scales).enumerate().fold((0., 0), |b, (r, (v, s))| if (v / s).abs() > b.0 { ((v / s).abs(), r) } else { b })
}

fn section() -> Value {
    let path = std::env::var("G1C09_FEED_SECTION").expect("G1C09_FEED_SECTION: the compiled feed section JSON");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
#[ignore = "G1-C09 prototype measurement: needs G1C09_FEED_SECTION"]
fn g1_c09_feed_block() {
    cpu::prefer_performance_core();
    let block = Block::new(&section());
    let mut report = json!({ "restrictionForm": if std::env::var("G1C09_DROP_FORM").is_ok() { "drop-accumulating demonstration" } else { "kernel restriction_flux" },
        "calibration": block.pump.calibration.clone(),
        "heaters": block.heaters.iter().map(|h| json!({"cdaIn_m2": h.cda_in, "cdaChannel_m2": h.cda_ch, "cdaOut_m2": h.cda_out, "cdaBypass_m2": h.cda_byp})).collect::<Vec<_>>(),
        "branch": {"cdaIso_m2": block.cda_iso, "cdaFcvFull_m2": block.cda_fcv, "hFeed0_J_kg": block.h_feed0},
        "census": {"differential": (0..N).filter(|j| is_differential(*j)).count(), "algebraic": (0..N).filter(|j| !is_differential(*j)).count(), "ports": NPORTS},
        "shells": block.shells.iter().map(|s| json!({"gShell_W_K": s.g_shell, "gTube_W_K": s.g_tube, "cdaExtraction_m2": s.cda_ext, "cdaDrain_m2": s.cda_drain, "pPrepared_Pa": s.p0, "wallPrepared_K": s.tw0})).collect::<Vec<_>>() });

    // G1.3 (a): the prepared state, made consistent by stock IDACalcIC, at the
    // reference SG pressure (6.0 MPa) and at the emergent 6.36314 MPa (D2).
    // S4-D6 / S4-D10 (c): at the prepared SG pressure (reference-operating-hot,
    // S2-D18) the MANUAL FCV openings that deliver the SG owner's A/B steam
    // flow (ld01-s2-sg-boundaries, through the compiler), the hardware
    // unchanged; stock IDACalcIC with the two openings as unknowns.
    let sec = section();
    let p_d2 = sec["branches"]["sgPreparedPressure_Pa"].as_f64().unwrap();
    let steam = &sec["cascade"]["initialDemand"]["flow_kg_s"];
    let targets = [steam["A"].as_f64().unwrap(), steam["B"].as_f64().unwrap()];
    let mut prep = block.prepared_ports(p_d2);
    prep.fcv_target = Some(targets);
    let mut yu = block.prepared();
    yu.extend([0.7, 0.7]);
    let mut ypu = vec![0.; N + 2];
    consistent(&block, &prep, &mut yu, &mut ypu).unwrap();
    let u_star = [yu[N], yu[N + 1]];
    let prep_rows = block.values(&yu, &ypu, &prep).unwrap();
    report["fcvPreparation_S4D6"] = json!({"sgPressure_Pa": p_d2, "targetFlow_kg_s": targets, "nominalM0_kg_s": block.pump.m0, "openingA": u_star[0], "openingB": u_star[1],
        "header_Pa": yu[42], "fcvInlet_Pa": [yu[44], yu[46]], "pumpFlows_kg_s": [yu[16], yu[17]], "discharge_Pa": yu[18],
        "scaledMaxRow": scaled_max(&block, &yu, &prep_rows).0, "tubeH4_dMdt": ypu[12]});
    let mut states = Vec::new();
    for (label, p_sg, u) in [("reference_6.0MPa", 6.0e6, [0.7, 0.7]), ("prepared_D2_S4D6", p_d2, u_star)] {
        let mut ports = block.prepared_ports(p_sg);
        ports.u_fcv = u;
        let mut y = block.prepared();
        let mut yp = vec![0.; N];
        let y_guess = y.clone();
        consistent(&block, &ports, &mut y, &mut yp).unwrap();
        let rows = block.values(&y, &yp, &ports).unwrap();
        let (worst, at) = scaled_max(&block, &y, &rows);
        // Recorded, judged in the receipt: the restriction rows' own evaluation
        // floor (cancellation in h0 - h at a 5 kPa drop) is about 1e-11.
        assert!(worst <= 1e-9, "{label}: scaled residual {worst:e} at {}", COORD_NAMES[at]);
        let algebraic: Value = (0..N).filter(|j| !is_differential(*j)).map(|j| (COORD_NAMES[j].to_string(), json!({"prepared": y[j], "guess": y_guess[j]}))).collect::<serde_json::Map<_, _>>().into();
        let rates: Value = (0..N).filter(|j| is_differential(*j)).map(|j| (COORD_NAMES[j].to_string(), json!(yp[j]))).collect::<serde_json::Map<_, _>>().into();
        report[label] = json!({"scaledMaxRow": worst, "meetsG13": worst <= 1e-12, "worstRow": COORD_NAMES[at], "algebraic": algebraic, "rates": rates,
            "feed_kg_s": {"A": y[43], "B": y[45]}, "header_Pa": y[42], "discharge_Pa": y[18], "fcvOpening": u});
        states.push((label, ports, y, yp));
    }
    {
        let ports = block.prepared_ports(p_d2);
        let mut y = block.prepared();
        let mut yp = vec![0.; N];
        consistent(&block, &ports, &mut y, &mut yp).unwrap();
        report["D2_at_MANUAL_0.70"] = json!({"feed_kg_s": {"A": y[43], "B": y[45]}, "header_Pa": y[42]});
    }
    let (_, ports, y0, yp0) = states[0].clone();

    // G1.2: structural pattern of dF/dy + dF/dy' at the prepared state.
    let t = cpu::thread_cpu_s();
    let a = block.partials(&y0, &yp0, &ports).unwrap();
    let jacobian_cpu = cpu::thread_cpu_s() - t;
    let mut nnz = 0;
    for (j, column) in a.iter().enumerate() {
        for (r, v) in column.iter().enumerate() {
            if *v != 0. || (r == j && yp_coefficient(&block, r) != 0.) {
                nnz += 1;
            }
        }
    }
    report["census"]["structuralNonzeros"] = json!(nnz);

    // G1.3 (c): analytic partials against central differences.
    let scales = block.row_scales(&y0);
    let mut worst = (0f64, String::new());
    let mut compared = 0;
    let mut unresolved = 0;
    for j in 0..N {
        // Column scale: flows by m0, other coordinates by their prepared value.
        let pressure = (14..N).contains(&j) && COORD_NAMES[j].starts_with('p');
        let column = if COORD_NAMES[j].starts_with('m') { block.pump.m0 } else { y0[j].abs() };
        // Steps: 1 Pa (the 5 kPa restriction drops bound the truncation), 1e-3 m0
        // for flows, 1e-4 of the value for stocks and speeds (the stocks reach
        // the restriction rows only through the donor enthalpy, a weak path).
        let step = if COORD_NAMES[j].starts_with("p_shell") { 0.1 } else if pressure { 1. } else if COORD_NAMES[j].starts_with('m') { 1e-3 * column } else { 1e-4 * column };
        let (mut up, mut dn) = (y0.clone(), y0.clone());
        up[j] += step;
        dn[j] -= step;
        let (fu, fd) = (block.values(&up, &yp0, &ports).unwrap(), block.values(&dn, &yp0, &ports).unwrap());
        for r in 0..N {
            let fdv = (fu[r] - fd[r]) / (2. * step);
            let an = a[j][r];
            // Central differences resolve an entry only when its change over the
            // step clears the row's evaluation noise (about 1e-11 of the row scale
            // for the restriction rows) by three decades.
            if an.abs().max(fdv.abs()) * step <= 1e-7 * scales[r] {
                if an != 0. || fdv != 0. {
                    unresolved += 1;
                }
                continue;
            }
            compared += 1;
            let rel = (an - fdv).abs() / an.abs().max(fdv.abs());
            if rel > 1e-6 && std::env::var("G1C09_DEBUG").is_ok() {
                // Richardson check at a 10x smaller and 10x larger step.
                let probe = |h: f64| {
                    let (mut u2, mut d2) = (y0.clone(), y0.clone());
                    u2[j] += h;
                    d2[j] -= h;
                    (block.values(&u2, &yp0, &ports).unwrap()[r] - block.values(&d2, &yp0, &ports).unwrap()[r]) / (2. * h)
                };
                eprintln!("MISMATCH d {}/d {}: analytic {an:e} fd {fdv:e} fd/10 {:e} fd*10 {:e} step {step:e}", COORD_NAMES[r], COORD_NAMES[j], probe(step / 10.), probe(step * 10.));
            }
            if rel > worst.0 {
                worst = (rel, format!("d {} / d {}", COORD_NAMES[r], COORD_NAMES[j]));
            }
        }
    }
    report["derivatives"] = json!({"entriesCompared": compared, "maxRelative": worst.0, "at": worst.1,
        "belowDifferenceResolution": unresolved, "resolutionRule": "|entry|*step > 1e-7 * row scale (1e4 x the restriction rows' evaluation floor)"});
    assert!(worst.0 <= 1e-6, "analytic vs central difference {worst:?}");

    // G1.3 (b): directional checks on every port: the declared receiving rows
    // move with the declared sign and no other row moves.
    let declared = |id: usize| -> Vec<(usize, f64)> {
        match id {
            0 | 1 => vec![(2 * id, -1.), (2 * id + 1, -1.)],
            2 | 3 => vec![(2 * (id - 2) + 1, -1.)],
            4 | 5 => vec![(2 * (id - 4) + 1, -1.)],
            6 | 7 => vec![(4 + id - 6, -1.)],
            8 => vec![(7, -1.)],
            12 | 13 => vec![(44 + 2 * (id - 12), 1.)],
            14..=17 => vec![(20 + 5 * (id - 14), -1.)],
            18..=21 => vec![(22 + 5 * (id - 18), -1.)],
            26 | 27 => vec![(43 + 2 * (id - 26), -1.)],
            28 | 29 => vec![(44 + 2 * (id - 28), -1.)],
            30..=32 => vec![(62 + id - 30, -1.)],
            33..=35 => vec![(62 + id - 33, 1.), (48 + 2 * (id - 33), -1.)],
            36 => vec![(47, -1.), (48, -1.)],
            37 => vec![(48, -1.)],
            38 => vec![(51, -1.), (52, -1.)],
            39 => vec![(52, -1.)],
            40 => vec![(47, 1.), (48, 1.)],
            41..=43 => vec![(62 + id - 41, -1.)],
            _ => vec![],
        }
    };
    let mut directional = serde_json::Map::new();
    for id in 0..NPORTS {
        let expect = declared(id);
        if expect.is_empty() {
            // Closed bypasses: identity rows (opening is class R). H2–H4 wall heats: replaced by the wall law.
            let note = match id {
                9..=11 => "replaced by the H2–H4 wall law",
                44 | 45 => "drain law held: saturated-liquid donor seeding refused by restriction_flux (KERN finding)",
                _ => "closed: identity row, opening is class R",
            };
            directional.insert(PORT_NAMES[id].into(), json!(note));
            continue;
        }
        let d = block.port_partials(&y0, &yp0, &ports, id).unwrap();
        for (r, v) in d.iter().enumerate() {
            match expect.iter().find(|(row, _)| *row == r) {
                Some((_, sign)) => assert!(v * sign > 0., "{}: row {} moved {v:e}, declared sign {sign}", PORT_NAMES[id], COORD_NAMES[r]),
                None => assert!(*v == 0., "{}: undeclared row {} moved {v:e}", PORT_NAMES[id], COORD_NAMES[r]),
            }
        }
        directional.insert(PORT_NAMES[id].into(), expect.iter().map(|(r, s)| json!({"row": COORD_NAMES[*r], "sign": s, "partial": d[*r]})).collect());
    }
    report["directional"] = directional.into();

    // One-pump loss at zero time: the consistent algebraic state with
    // omega.P1 lowered by 1 %. The rigid tube stores fix their pressures at
    // zero time, so the change enters H1's tube as dM/dt and reaches the
    // header only through the tubes' compressibility (the dynamic run below).
    let mut y1 = y0.clone();
    let mut yp1 = yp0.clone();
    y1[4] *= 0.99;
    consistent(&block, &ports, &mut y1, &mut yp1).unwrap();
    let zero_time = json!({"dm_P1": y1[16] - y0[16], "dm_P2": y1[17] - y0[17], "dp_DISCHARGE": y1[18] - y0[18],
        "dMdt_tube_H1": yp1[6] - yp0[6], "dm_A": y1[43] - y0[43], "dm_B": y1[45] - y0[45]});
    assert!(y1[16] < y0[16] && y1[17] > y0[17] && y1[18] < y0[18] && yp1[6] < yp0[6], "one-pump loss zero-time direction {zero_time}");
    report["onePumpLoss_zeroTime"] = zero_time;

    // One-pump loss, dynamic: FW.P1 loses motive support at t = 0 (class S:
    // the motor torque enters only the rotor's rate); stock IDA from the
    // prepared state until P1's flow falls to 5 % of nominal (the check
    // lock, class R, is outside this prototype).
    let mut lost = ports.clone();
    lost.supported[0] = false;
    lost.suction_held = Some([y0[14], y0[15]]);
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let atol = tolerances(&y);
    let mut ida = Ida::new(
        Sys { n: N, block: block.clone(), ports: lost, root_p1_fraction: Some(0.05), residuals: 0, jacobians: 0 },
        Initial { time: 0., y: &y, yp: &yp, differential: &differential(N), absolute_tolerance: &atol, relative_tolerance: 1e-6 },
    )
    .unwrap();
    ida.initialize(1e-4, &mut y, &mut yp).unwrap();
    let mut series = vec![json!({"t": 0., "m_A": y[43], "m_B": y[45], "p_HEADER": y[42], "m_P1": y[16], "m_P2": y[17], "omega_P1": y[4]})];
    let cpu0 = cpu::thread_cpu_s();
    let mut t_end = 0.;
    for step in 1..=60 {
        let target = 0.05 * step as f64;
        match ida.advance(target, &mut y, &mut yp).unwrap() {
            Advance::Reached(time) => t_end = time,
            Advance::Root { time, .. } => {
                t_end = time;
                series.push(json!({"t": time, "m_A": y[43], "m_B": y[45], "p_HEADER": y[42], "m_P1": y[16], "m_P2": y[17], "omega_P1": y[4], "root": "m_P1 = 0.05 m0"}));
                break;
            }
        }
        series.push(json!({"t": t_end, "m_A": y[43], "m_B": y[45], "p_HEADER": y[42], "m_P1": y[16], "m_P2": y[17], "omega_P1": y[4]}));
    }
    let run_cpu = cpu::thread_cpu_s() - cpu0;
    let stats = ida.stats().unwrap();
    let value = |p: &Value, k: &str| p[k].as_f64().unwrap();
    for w in series.windows(2) {
        assert!(value(&w[1], "m_A") < value(&w[0], "m_A") && value(&w[1], "m_B") < value(&w[0], "m_B"),
            "both SG branch flows must fall: {} → {}", w[0], w[1]);
    }
    report["onePumpLoss_dynamic"] = json!({"series": series, "end_s": t_end, "cpu_s": run_cpu,
        "steps": stats.steps, "residuals": stats.residuals, "jacobians": stats.jacobians,
        "errorFailures": stats.error_failures, "convergenceFailures": stats.convergence_failures});

    // G1.4 inputs: per-call cost of this block's residual and dense Jacobian.
    let mut calls = 0;
    let t = cpu::thread_cpu_s();
    let reps = 50;
    for _ in 0..reps {
        block.eval(&If97, &y0, &yp0, &ports, None, None, &mut calls).unwrap();
    }
    let residual_cpu = (cpu::thread_cpu_s() - t) / reps as f64;
    let stage_calls = calls / reps;
    // The stage dominates the residual. Candidate for a lead numerical
    // decision: the same adiabat on a coarser stage grid (liquid, nearly
    // constant v); its difference from the nozzle-grid value at the
    // calibration stage, and its inversions.
    let p = &block.pump;
    let p_star0 = p.p_in0 + (p.shut - p.cross) * p.dp0;
    let (fine, fine_calls) = adiabat_on(&If97, k(p.p_in0), k(p.h_in0), k(p_star0), LOG_STEP).unwrap();
    let coarse: Vec<Value> = [8usize, 4, 2, 1]
        .iter()
        .map(|steps| {
            let log_step = (p_star0 / p.p_in0).ln() / *steps as f64 * (1. + 1e-12);
            let (h, calls) = adiabat_on(&If97, k(p.p_in0), k(p.h_in0), k(p_star0), log_step).unwrap();
            json!({"steps": steps, "inversions": calls, "difference_J_kg": h.value - fine.value})
        })
        .collect();
    report["stageGrid"] = json!({"nozzleGrid": {"logStep": LOG_STEP, "inversions": fine_calls, "hStar_J_kg": fine.value}, "coarser": coarse});
    // Zero-flow conditioning of an algebraic restriction: dG/dp_back of the
    // H1 inlet ISO as its drop vanishes (the T2 stagnation regime).
    let h1 = &block.heaters[0];
    let conditioning: Vec<Value> = [5e3, 50., 0.5, 5e-3, 5e-5]
        .iter()
        .map(|drop| {
            let pb = S::new(block.junction[0] - drop, 1.);
            let g = flux(&If97, k(block.junction[0]), k(h1.h_ref_in), pb).unwrap();
            json!({"drop_Pa": drop, "flow_kg_s": h1.cda_in * g.value, "dFlow_dpBack_kg_s_Pa": h1.cda_in * g.direction})
        })
        .collect();
    report["zeroFlowConditioning"] = json!(conditioning);
    report["stageSteps"] = json!(std::env::var("G1C09_STAGE_STEPS").ok());
    report["cost"] = json!({"residual_cpu_s": residual_cpu, "denseJacobian_cpu_s": jacobian_cpu,
        "stageAdiabatInversionsPerResidual": stage_calls, "load": cpu::load_average()});
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if let Ok(path) = std::env::var("G1C09_RECEIPT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#apparent-level-is-not-liquid-inventory
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#compact-apparent-level-allocation-c08-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/instrumentation.md#selected-channels
//! C08 apparent-level prototype: TEST-ONLY, not the joined owner, not S3
//! or S5 evidence. One SG secondary on the selected bulk-equilibrium chart
//! with prescribed heat, steam and feed (the response comparison's
//! apparatus shape), plus the wiki's vapor-distribution law as the compact
//! allocation would add it to the SG owner:
//!
//! | # | Coordinate | Kind | Row (physical units, then scaled) |
//! | --- | --- | --- | --- |
//! | 0 | `M` | differential | `M' - (feed - steam)` |
//! | 1 | `U` | differential | `U' - (Q + feed h_feed - steam h_g(p))` |
//! | 2 | `p` | algebraic | `M - chart_M(p, V_l)` |
//! | 3 | `V_l` | algebraic | `U - chart_U(p, V_l)` |
//! | 4 | `M_v` | algebraic | `M_v - rho_g(p) (V - V_l)` |
//! | 5 | `beta` | differential | `beta' - (beta_eq - beta) / tau_distribution` |
//! | 6 | `V_sub` | algebraic | `V_sub - beta (V - V_l)` |
//! | 7 | `L_NR` | differential | `L_NR' - ((V_l + V_sub)/A - L_NR) / nrLag` |
//!
//! `beta_eq = min(V_g, V_sub,max, tau_residence q) / V_g`, `q = m_evap /
//! rho_g` (pure steam: `vbar_steam = 1/rho_v`), `m_evap = max(0, M_v' +
//! steam outflow - steam inflow)`. `M_v'` is the integrator's rate of the
//! algebraic vapor mass: the steam phase derivative implied by conservative
//! property recovery, never another vapor-mass integration. The residence
//! time is derived once on IF97 from the block's nominal reference:
//! `tau_residence = V_sub,nom rho_g(p_nom) / F_nom`. Row 7 is the NR
//! channel's first-order lag (in the joined unit it is acquired from dense
//! output, class O); it is integrated here only to read the channel.
//!
//! The distribution coordinates carry no mass or energy: rows 0-3 are the
//! S2 secondary's rows unchanged. Kinks of `max`/`min` are declared roots
//! (class R in the joined unit); a crossing here restarts from the exact
//! consistent rates, as the joined restart does.
//!
//! Opt-in environment: `LD01_C08_SECTION` (the section compiled by
//! `reference-design-operating-sg-level.ts`), `LD01_C08_PACKET` (a joined
//! packet: prepared SG stocks, A/B demand, feed state), `LD01_C08_SETTLED`
//! (`:`-separated settled-state files of that packet: S2-07 and/or the S3
//! settle) and `LD01_C08_RECEIPT` (a new receipt path).
#![cfg(feature = "ida")]

use leitbild_operating_plant::{
    sg::chart,
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, System},
};
use serde_json::{Value, json};

const N: usize = 8;
const IDS: [f64; N] = [1., 1., 0., 0., 0., 1., 0., 1.];
/// Root order: the `max` kink, the three `min` kinks, the case's stop.
const ROOTS: usize = 5;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn need(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .filter(|x| x.is_finite())
        .unwrap_or_else(|| panic!("section key {key} missing or nonfinite"))
}

/// The compiled C08 section: the distribution block and the NR channel
/// block, nothing defaulted.
#[derive(Clone, Copy, Debug)]
struct Selection {
    nominal_submerged_m3: f64,
    nominal_pressure_pa: f64,
    nominal_steam_kg_s: f64,
    maximum_submerged_m3: f64,
    distribution_s: f64,
    prepared_beta: f64,
    area_m2: f64,
    nr_low_m: f64,
    nr_high_m: f64,
    nr_lag_s: f64,
}
fn selection() -> Selection {
    let path = std::env::var("LD01_C08_SECTION").expect("LD01_C08_SECTION");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("section"))
        .expect("section json");
    let d = &v["distribution"];
    let i = &v["indication"];
    let span = i["nrSpan_m"].as_array().expect("nrSpan_m");
    assert_eq!(span.len(), 2, "nrSpan_m");
    Selection {
        nominal_submerged_m3: need(d, "nominalSubmergedVolume_m3"),
        nominal_pressure_pa: need(d, "nominalPressure_Pa"),
        nominal_steam_kg_s: need(d, "nominalSteamFlow_kg_s"),
        maximum_submerged_m3: need(d, "maximumSubmergedVolume_m3"),
        distribution_s: need(d, "distributionTime_s"),
        prepared_beta: need(d, "preparedDistribution"),
        area_m2: need(i, "indicatedLevelArea_m2"),
        nr_low_m: span[0].as_f64().expect("nr low"),
        nr_high_m: span[1].as_f64().expect("nr high"),
        nr_lag_s: need(i, "nrLag_s"),
    }
}

/// The residence time from the nominal reference on the runtime law, once.
fn residence(sel: &Selection) -> f64 {
    let sat = WaterProperties::saturation(&If97, s(sel.nominal_pressure_pa)).expect("nominal sat");
    sel.nominal_submerged_m3 * sat.vapor.density.value / sel.nominal_steam_kg_s
}

/// The distribution law at one state: the raw net phase-change rate, the
/// clamped evaporation, the held volume `tau_residence q`, its cap and the
/// equilibrium fraction.
#[derive(Clone, Copy, Debug)]
struct Law {
    raw: Scalar,
    evaporation: Scalar,
    held_m3: Scalar,
    cap_m3: Scalar,
    beta_eq: Scalar,
}

#[derive(Clone, Debug)]
struct Apparatus {
    sel: Selection,
    residence_s: f64,
    volume_m3: f64,
    feed_enthalpy_j_kg: f64,
    heat_w: f64,
    steam_kg_s: f64,
    feed_kg_s: f64,
    /// The case's stop pressure (a root); `None` disarms it.
    stop_pa: Option<f64>,
    scales: [f64; N],
}

impl Apparatus {
    fn law(&self, mv_rate: Scalar, rg: Scalar, vg: Scalar) -> Law {
        // Steam component outflow: the pickup gas; no steam inflow here.
        let raw = mv_rate + s(self.steam_kg_s);
        let evaporation = if raw.value > 0. { raw } else { s(0.) };
        // Pure steam: vbar_steam = a/(rho_v a) = 1/rho_v.
        let held_m3 = s(self.residence_s) * evaporation / rg;
        let cap_m3 = if vg.value < self.sel.maximum_submerged_m3 {
            vg
        } else {
            s(self.sel.maximum_submerged_m3)
        };
        let target = if held_m3.value < cap_m3.value {
            held_m3
        } else {
            cap_m3
        };
        Law {
            raw,
            evaporation,
            held_m3,
            cap_m3,
            beta_eq: target / vg,
        }
    }
    fn physical(&self, y: &[Scalar]) -> [Scalar; N] {
        let mut x = [s(0.); N];
        for i in 0..N {
            x[i] = y[i] * s(self.scales[i]);
        }
        x
    }
    fn rows(&self, y: &[Scalar], yp: &[Scalar]) -> Result<[Scalar; N], Failure> {
        let x = self.physical(y);
        let r = self.physical(yp);
        let (m, u, p, vl, mv, beta, vsub, lnr) = (x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7]);
        if !(p.value > 0. && p.value.is_finite()) {
            return Err(Failure::Recoverable(format!("pressure trial {}", p.value)));
        }
        if !(vl.value > 0. && vl.value < self.volume_m3) {
            return Err(Failure::Recoverable(format!(
                "liquid volume trial {}",
                vl.value
            )));
        }
        let sat = WaterProperties::saturation(&If97, p)
            .map_err(|e| Failure::Recoverable(format!("saturation: {e}")))?;
        let (cm, cu) = chart(self.volume_m3, vl, p, &sat);
        let (hg, rg) = (sat.vapor.enthalpy, sat.vapor.density);
        let vg = s(self.volume_m3) - vl;
        let law = self.law(r[4], rg, vg);
        let (feed, steam) = (s(self.feed_kg_s), s(self.steam_kg_s));
        let apparent = (vl + vsub) / s(self.sel.area_m2);
        let out = [
            r[0] - (feed - steam),
            r[1] - (s(self.heat_w) + feed * s(self.feed_enthalpy_j_kg) - steam * hg),
            m - cm,
            u - cu,
            mv - rg * vg,
            r[5] - (law.beta_eq - beta) / s(self.sel.distribution_s),
            vsub - beta * vg,
            r[7] - (apparent - lnr) / s(self.sel.nr_lag_s),
        ];
        // Rows in solver scaling: kg and J rows by their stock's scale.
        let row_scale = [
            self.scales[0],
            self.scales[1],
            self.scales[0],
            self.scales[1],
            self.scales[4],
            1.,
            self.scales[6],
            self.scales[7],
        ];
        let mut scaled = [s(0.); N];
        for i in 0..N {
            scaled[i] = out[i] / s(row_scale[i]);
        }
        if scaled
            .iter()
            .any(|v| !(v.value.is_finite() && v.direction.is_finite()))
        {
            return Err(Failure::Recoverable("nonfinite row".into()));
        }
        Ok(scaled)
    }
    fn values(&self, y: &[f64], yp: &[f64]) -> Result<[f64; N], Failure> {
        let ys: Vec<Scalar> = y.iter().map(|v| s(*v)).collect();
        let yps: Vec<Scalar> = yp.iter().map(|v| s(*v)).collect();
        Ok(self.rows(&ys, &yps)?.map(|v| v.value))
    }
    /// Column `j` of dF/dy + cj dF/dy' by one seeded evaluation.
    fn column(&self, y: &[f64], yp: &[f64], cj: f64, j: usize) -> Result<[f64; N], Failure> {
        let ys: Vec<Scalar> = (0..N)
            .map(|i| Scalar::new(y[i], if i == j { 1. } else { 0. }))
            .collect();
        let yps: Vec<Scalar> = (0..N)
            .map(|i| Scalar::new(yp[i], if i == j { cj } else { 0. }))
            .collect();
        Ok(self.rows(&ys, &yps)?.map(|v| v.direction))
    }
    /// The law and readings at a state with its rates.
    fn reading(&self, y: &[f64], yp: &[f64]) -> Value {
        let x: Vec<f64> = (0..N).map(|i| y[i] * self.scales[i]).collect();
        let sat = WaterProperties::saturation(&If97, s(x[2])).expect("sat");
        let vg = self.volume_m3 - x[3];
        let law = self.law(s(yp[4] * self.scales[4]), sat.vapor.density, s(vg));
        let collapsed = x[3] / self.sel.area_m2;
        let apparent = (x[3] + x[6]) / self.sel.area_m2;
        let span = self.sel.nr_high_m - self.sel.nr_low_m;
        json!({
            "M_kg": x[0], "U_J": x[1], "p_Pa": x[2], "V_l_m3": x[3], "M_v_kg": x[4],
            "beta": x[5], "V_sub_m3": x[6], "V_g_m3": vg,
            "collapsed_m": collapsed, "apparent_m": apparent, "NR_m": x[7],
            "NR_percent": 100. * (x[7] - self.sel.nr_low_m) / span,
            "collapsedProxy_percent": 100. * (collapsed - self.sel.nr_low_m) / span,
            "m_evap_kg_s": law.evaporation.value, "raw_phase_change_kg_s": law.raw.value,
            "held_m3": law.held_m3.value, "cap_m3": law.cap_m3.value, "beta_eq": law.beta_eq.value,
            "Mv_rate_kg_s": yp[4] * self.scales[4],
        })
    }
    /// The exact consistent rates at `y` (closed form, no iteration): the
    /// stock rates from rows 0-1, the chart rates from the 2x2 chart
    /// Jacobian (Cramer), then `M_v'`, `beta'`, `V_sub'` and `L_NR'`.
    fn rates(&self, y: &[f64]) -> Result<[f64; N], Failure> {
        let x: Vec<f64> = (0..N).map(|i| y[i] * self.scales[i]).collect();
        let (p, vl, beta, vsub, lnr) = (x[2], x[3], x[5], x[6], x[7]);
        let fatal = |e: &str| Failure::Fatal(e.to_string());
        let sat_p =
            WaterProperties::saturation(&If97, Scalar::new(p, 1.)).map_err(|_| fatal("sat"))?;
        let sat_0 = WaterProperties::saturation(&If97, s(p)).map_err(|_| fatal("sat"))?;
        let (mp, up) = chart(self.volume_m3, s(vl), Scalar::new(p, 1.), &sat_p);
        let (mvl, uvl) = chart(self.volume_m3, Scalar::new(vl, 1.), s(p), &sat_0);
        let (mp, up, mvl, uvl) = (mp.direction, up.direction, mvl.direction, uvl.direction);
        let hg = sat_0.vapor.enthalpy.value;
        let m_rate = self.feed_kg_s - self.steam_kg_s;
        let u_rate = self.heat_w + self.feed_kg_s * self.feed_enthalpy_j_kg - self.steam_kg_s * hg;
        let det = mp * uvl - mvl * up;
        let p_rate = (m_rate * uvl - mvl * u_rate) / det;
        let vl_rate = (mp * u_rate - up * m_rate) / det;
        let rg = sat_0.vapor.density.value;
        let rg_p = sat_p.vapor.density.direction;
        let vg = self.volume_m3 - vl;
        let mv_rate = rg_p * p_rate * vg - rg * vl_rate;
        let law = self.law(s(mv_rate), s(rg), s(vg));
        let beta_rate = (law.beta_eq.value - beta) / self.sel.distribution_s;
        let vsub_rate = beta_rate * vg - beta * vl_rate;
        let lnr_rate = ((vl + vsub) / self.sel.area_m2 - lnr) / self.sel.nr_lag_s;
        let physical = [
            m_rate, u_rate, p_rate, vl_rate, mv_rate, beta_rate, vsub_rate, lnr_rate,
        ];
        let mut yp = [0.; N];
        for i in 0..N {
            yp[i] = physical[i] / self.scales[i];
        }
        Ok(yp)
    }
    /// The chart block's determinant (index-1 evidence: the algebraic block
    /// `[chart; M_v; V_sub]` is lower triangular around it with unit
    /// diagonals).
    fn chart_determinant(&self, y: &[f64]) -> f64 {
        let (p, vl) = (y[2] * self.scales[2], y[3] * self.scales[3]);
        let sat_p = WaterProperties::saturation(&If97, Scalar::new(p, 1.)).expect("sat");
        let sat_0 = WaterProperties::saturation(&If97, s(p)).expect("sat");
        let (mp, up) = chart(self.volume_m3, s(vl), Scalar::new(p, 1.), &sat_p);
        let (mvl, uvl) = chart(self.volume_m3, Scalar::new(vl, 1.), s(p), &sat_0);
        mp.direction * uvl.direction - mvl.direction * up.direction
    }
    /// A state on the chart at `(p, V_l)` with distribution `beta` and the
    /// channel at rest at the apparent level, in solver scaling.
    fn state(&self, p: f64, vl: f64, beta: f64) -> [f64; N] {
        let sat = WaterProperties::saturation(&If97, s(p)).expect("sat");
        let (m, u) = chart(self.volume_m3, s(vl), s(p), &sat);
        let vg = self.volume_m3 - vl;
        let vsub = beta * vg;
        let physical = [
            m.value,
            u.value,
            p,
            vl,
            sat.vapor.density.value * vg,
            beta,
            vsub,
            (vl + vsub) / self.sel.area_m2,
        ];
        let mut y = [0.; N];
        for i in 0..N {
            y[i] = physical[i] / self.scales[i];
        }
        y
    }
    /// The same state with `beta` at its equilibrium for the current rates
    /// (`beta` does not enter `M_v'`, so one evaluation is exact) and the
    /// channel at rest: what a settle hands on after many `tau_distribution`.
    fn equilibrated(&self, y: &[f64; N]) -> [f64; N] {
        let yp = self.rates(y).expect("rates");
        let x2 = y[2] * self.scales[2];
        let x3 = y[3] * self.scales[3];
        let sat = WaterProperties::saturation(&If97, s(x2)).expect("sat");
        let law = self.law(
            s(yp[4] * self.scales[4]),
            sat.vapor.density,
            s(self.volume_m3 - x3),
        );
        let mut out = *y;
        let p = x2;
        let fresh = self.state(p, x3, law.beta_eq.value);
        out[5] = fresh[5];
        out[6] = fresh[6];
        out[7] = fresh[7];
        out
    }
}

impl System for Apparatus {
    /// Unreduced: every coordinate stands for itself (E-NUC).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    fn dimension(&self) -> usize {
        N
    }
    fn nonzeros(&self) -> usize {
        N * N
    }
    fn root_count(&self) -> usize {
        ROOTS
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out.copy_from_slice(&self.values(y, yp)?);
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
        for j in 0..N {
            let column = self.column(y, yp, cj, j)?;
            pointers[j] = (j * N) as i64;
            for i in 0..N {
                data[j * N + i] = column[i];
                rows[j * N + i] = i as i64;
            }
        }
        pointers[N] = (N * N) as i64;
        Ok(())
    }
    fn roots(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let p = y[2] * self.scales[2];
        let vl = y[3] * self.scales[3];
        let sat = WaterProperties::saturation(&If97, s(p))
            .map_err(|e| Failure::Fatal(format!("root saturation: {e}")))?;
        let vg = self.volume_m3 - vl;
        let law = self.law(s(yp[4] * self.scales[4]), sat.vapor.density, s(vg));
        out[0] = law.raw.value;
        out[1] = law.held_m3.value - self.sel.maximum_submerged_m3;
        out[2] = law.held_m3.value - vg;
        out[3] = vg - self.sel.maximum_submerged_m3;
        out[4] = self.stop_pa.map_or(1., |stop| p - stop);
        Ok(())
    }
}

/// One prescribed segment of a case.
#[derive(Clone, Copy, Debug)]
struct Segment {
    duration_s: f64,
    heat_w: f64,
    steam_kg_s: f64,
    feed_kg_s: f64,
    stop_pa: Option<f64>,
}

/// Run segments from `y0`, sampling every `sample_s`; a kink root restarts
/// from exact consistent rates (class R); the stop root ends the case.
fn run(base: &Apparatus, y0: [f64; N], segments: &[Segment], sample_s: f64) -> Value {
    let mut sys = base.clone();
    let mut y = y0;
    let mut t = 0.;
    let mut samples = Vec::new();
    let mut restarts = Vec::new();
    let mut stopped: Option<f64> = None;
    let first = segments[0];
    sys.heat_w = first.heat_w;
    sys.steam_kg_s = first.steam_kg_s;
    sys.feed_kg_s = first.feed_kg_s;
    sys.stop_pa = first.stop_pa;
    let yp0 = sys.rates(&y).expect("initial rates");
    let start_rows = sys.values(&y, &yp0).expect("initial rows");
    let mut yp = yp0;
    samples.push(json!({"t_s": t, "state": sys.reading(&y, &yp)}));
    let atol = [1e-10; N];
    let mut ida = Ida::new(
        sys.clone(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &IDS,
            absolute_tolerance: &atol,
            relative_tolerance: 1e-9,
        },
    )
    .expect("stock IDA");
    let mut segment_end = 0.;
    for (k, seg) in segments.iter().enumerate() {
        if stopped.is_some() {
            break;
        }
        segment_end += seg.duration_s;
        if k > 0 {
            // A boundary step: a known-time class R restart.
            let next = Apparatus {
                heat_w: seg.heat_w,
                steam_kg_s: seg.steam_kg_s,
                feed_kg_s: seg.feed_kg_s,
                stop_pa: seg.stop_pa,
                ..sys.clone()
            };
            sys = next;
            *ida.system_mut() = sys.clone();
            yp = sys.rates(&y).expect("boundary rates");
            ida.reinitialize(t, &y, &yp).expect("boundary restart");
            restarts.push(json!({"t_s": t, "kind": "boundary"}));
        }
        let mut target = t + sample_s;
        while stopped.is_none() && t < segment_end {
            let goal = target.min(segment_end);
            match ida.advance(goal, &mut y, &mut yp).expect("advance") {
                Advance::Reached(reached) => {
                    t = reached;
                    samples.push(json!({"t_s": t, "state": sys.reading(&y, &yp)}));
                    target += sample_s;
                }
                Advance::Root { time, directions } => {
                    t = time;
                    let state = sys.reading(&y, &yp);
                    if directions[4] != 0 {
                        stopped = Some(time);
                        samples.push(json!({"t_s": t, "state": state, "event": "stop pressure"}));
                    } else {
                        restarts.push(json!({"t_s": t, "kind": "kink", "directions": directions,
                            "state": state}));
                        yp = sys.rates(&y).expect("kink rates");
                        ida.reinitialize(t, &y, &yp).expect("kink restart");
                    }
                }
            }
        }
    }
    let stats = ida.stats().expect("stats");
    json!({
        "startRowsMaxAbs": start_rows.iter().fold(0f64, |a, v| a.max(v.abs())),
        "stoppedAt_s": stopped, "restarts": restarts, "samples": samples,
        "ida": {"steps": stats.steps, "residuals": stats.residuals, "jacobians": stats.jacobians,
            "errorFailures": stats.error_failures, "convergenceFailures": stats.convergence_failures},
    })
}

fn extremes(run: &Value, key: &str) -> (f64, f64, f64, f64) {
    let samples = run["samples"].as_array().expect("samples");
    let first = samples[0]["state"][key].as_f64().expect("first");
    let last = samples[samples.len() - 1]["state"][key]
        .as_f64()
        .expect("last");
    let (lo, hi) = samples
        .iter()
        .map(|x| x["state"][key].as_f64().expect("value") - first)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| {
            (a.min(v), b.max(v))
        });
    (first, last - first, lo, hi)
}

/// The settled SG stocks of a joined packet's state file: the secondary
/// block's `[M, U, p, V_l, lifts...]` per SG, located by the chart identity
/// against the packet's prepared stocks (unique per SG; the inventory-holding
/// feed keeps `M` at its prepared scale exactly).
fn settled(packet: &Value, state: &Value) -> Vec<(String, f64, f64, f64, f64, f64)> {
    let y: Vec<f64> = state["y"]
        .as_array()
        .expect("y")
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let yp: Vec<f64> = state["yp"]
        .as_array()
        .expect("yp")
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let stocks = packet["thermal"]["secondaries"].as_array().expect("stocks");
    stocks
        .iter()
        .enumerate()
        .map(|(k, x)| {
            let id = x["id"].as_str().unwrap().to_string();
            let (m0, u0, p0, v) = (
                x["mass_kg"].as_f64().unwrap(),
                x["energy_j"].as_f64().unwrap().abs(),
                x["pressure_pa"].as_f64().unwrap(),
                x["volume_m3"].as_f64().unwrap(),
            );
            // Every block on the chart at this SG's prepared scales, in
            // layout order (the A/B blocks follow each other).
            let found: Vec<usize> = (0..y.len().saturating_sub(4))
                .filter(|&i| {
                    let (m, u, p, vl) = (y[i] * m0, y[i + 1] * u0, y[i + 2] * p0, y[i + 3] * v);
                    if !(p > 1e6 && p < 1e7 && vl > 1. && vl < v && m > 1e4) {
                        return false;
                    }
                    let sat = WaterProperties::saturation(&If97, s(p)).expect("sat");
                    let (cm, cu) = chart(v, s(vl), s(p), &sat);
                    ((cm.value - m) / m).abs() < 1e-9 && ((cu.value - u) / u).abs() < 1e-9
                })
                .collect();
            assert_eq!(
                found.len(),
                stocks.len(),
                "the chart identity must locate exactly one block per SG: {found:?}"
            );
            let i = found[k];
            (
                id,
                y[i] * m0,
                y[i + 1] * u0,
                y[i + 2] * p0,
                y[i + 3] * v,
                yp[i + 1] * u0,
            )
        })
        .collect()
}

fn base(sel: Selection, volume: f64, feed_h: f64, p: f64, m: f64, u: f64) -> Apparatus {
    let sat = WaterProperties::saturation(&If97, s(p)).expect("sat");
    Apparatus {
        sel,
        residence_s: residence(&sel),
        volume_m3: volume,
        feed_enthalpy_j_kg: feed_h,
        heat_w: 0.,
        steam_kg_s: 0.,
        feed_kg_s: 0.,
        stop_pa: None,
        scales: [m, u, p, volume, sat.vapor.density.value * 48., 1., 48., 10.],
    }
}

#[test]
#[ignore = "requires LD01_C08_SECTION"]
fn the_law_reproduces_the_authored_nominal_and_its_jacobian_is_exact() {
    let sel = selection();
    let (v, p, vl) = (120., sel.nominal_pressure_pa, 72.);
    let feed = WaterProperties::liquid(&If97, s(7.2e6), s(493.15))
        .expect("feed")
        .enthalpy
        .value;
    let sat = WaterProperties::saturation(&If97, s(p)).expect("sat");
    let (m, u) = chart(v, s(vl), s(p), &sat);
    let mut a = base(sel, v, feed, p, m.value, u.value);
    a.steam_kg_s = sel.nominal_steam_kg_s;
    a.feed_kg_s = sel.nominal_steam_kg_s;
    a.heat_w = sel.nominal_steam_kg_s * (sat.vapor.enthalpy.value - feed);
    let y = a.equilibrated(&a.state(p, vl, sel.prepared_beta));
    let yp = a.rates(&y).unwrap();
    let r = a.reading(&y, &yp);
    let rows = a.values(&y, &yp).unwrap();
    println!(
        "tau_residence (IF97) = {:.16} s; nominal reading {r}",
        a.residence_s
    );
    assert!(
        rows.iter().all(|v| v.abs() < 1e-12),
        "consistent rows {rows:?}"
    );
    // The authored identities: 12 m³ submerged, 7 m apparent, 6 m collapsed,
    // NR 60 %, beta = prepared 0.25.
    assert!((r["V_sub_m3"].as_f64().unwrap() - 12.).abs() < 1e-9);
    assert!((r["apparent_m"].as_f64().unwrap() - 7.).abs() < 1e-10);
    assert!((r["collapsed_m"].as_f64().unwrap() - 6.).abs() < 1e-12);
    assert!((r["NR_percent"].as_f64().unwrap() - 60.).abs() < 1e-8);
    assert!((r["beta"].as_f64().unwrap() - sel.prepared_beta).abs() < 1e-10);
    // Seeded columns against central differences at a nonsteady state
    // (heat -20 %, feed +10 %: every row and rate active).
    a.heat_w *= 0.8;
    a.feed_kg_s *= 1.1;
    let yp = a.rates(&y).unwrap();
    let mut worst: f64 = 0.;
    for cj in [1e1, 1e3, 1e5] {
        for j in 0..N {
            let seeded = a.column(&y, &yp, cj, j).unwrap();
            let h = 1e-7 * y[j].abs().max(1e-3);
            let (mut yu, mut yd, mut pu, mut pd) =
                (y.to_vec(), y.to_vec(), yp.to_vec(), yp.to_vec());
            yu[j] += h;
            yd[j] -= h;
            pu[j] += cj * h;
            pd[j] -= cj * h;
            let fu = a.values(&yu, &pu).unwrap();
            let fd = a.values(&yd, &pd).unwrap();
            for i in 0..N {
                let diff = (fu[i] - fd[i]) / (2. * h);
                let scale = seeded[i].abs().max(diff.abs()).max(1e-6);
                worst = worst.max((seeded[i] - diff).abs() / scale);
            }
        }
    }
    println!(
        "seeded vs central differences: worst relative {worst:.3e}; chart det {:.6e}",
        a.chart_determinant(&y)
    );
    assert!(worst < 1e-5, "seeded Jacobian {worst}");
}

#[test]
#[ignore = "requires LD01_C08_SECTION, LD01_C08_PACKET, LD01_C08_SETTLED, LD01_C08_RECEIPT"]
fn settled_state_apparent_level_swells_and_shrinks() {
    let sel = selection();
    let packet_path = std::env::var("LD01_C08_PACKET").expect("LD01_C08_PACKET");
    let packet: Value =
        serde_json::from_str(&std::fs::read_to_string(&packet_path).unwrap()).unwrap();
    let secondary = &packet["secondary"];
    let feed_p = need(&secondary["feed"], "pressure_Pa");
    let feed_t = need(&secondary["feed"], "temperature_K");
    let feed_h = WaterProperties::liquid(&If97, s(feed_p), s(feed_t))
        .expect("feed")
        .enthalpy
        .value;
    let receipt_path = std::env::var("LD01_C08_RECEIPT").expect("LD01_C08_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    let mut files = Vec::new();
    let started = std::time::Instant::now();
    for path in std::env::var("LD01_C08_SETTLED")
        .expect("LD01_C08_SETTLED")
        .split(':')
    {
        let state: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut sgs = Vec::new();
        for (k, (id, m, u, p, vl, u_rate)) in settled(&packet, &state).into_iter().enumerate() {
            let g = &secondary["steamGenerators"][k];
            assert_eq!(g["id"].as_str(), Some(id.as_str()));
            let v = need(g, "volume_m3");
            let steam = need(g, "steamDemand_kg_s");
            let sat = WaterProperties::saturation(&If97, s(p)).unwrap();
            let mut a = base(sel, v, feed_h, p, m, u);
            // The settled boundary: inventory-holding feed (feed = steam,
            // reliefs seated) and the heat that gives the settled U' exactly.
            let heat = u_rate + steam * (sat.vapor.enthalpy.value - feed_h);
            a.heat_w = heat;
            a.steam_kg_s = steam;
            a.feed_kg_s = steam;
            let hold = Segment {
                duration_s: 20.,
                heat_w: heat,
                steam_kg_s: steam,
                feed_kg_s: steam,
                stop_pa: None,
            };
            // (1) From the prepared distribution 0.25 to equilibrium.
            let prepared = a.state(p, vl, sel.prepared_beta);
            let relax = run(&a, prepared, &[hold], 0.5);
            // (2) The settled equilibrium: what a settle with the extension hands on.
            let eq = a.equilibrated(&prepared);
            let eq_rates = a.rates(&eq).unwrap();
            let nominal = a.reading(&eq, &eq_rates);
            // (3) Depressurisation by steam demand +20 % (heat and feed held)
            // to p0 - 0.5 MPa.
            let steam_step = run(
                &a,
                eq,
                &[Segment {
                    duration_s: 120.,
                    steam_kg_s: 1.2 * steam,
                    stop_pa: Some(p - 0.5e6),
                    ..hold
                }],
                0.25,
            );
            // (4) The S2 contrary analogue: heat lost (Q = 10 %), steam held,
            // inventory-holding feed, to p0 - 0.5 MPa.
            let heat_cut = run(
                &a,
                eq,
                &[Segment {
                    duration_s: 120.,
                    heat_w: 0.1 * heat,
                    stop_pa: Some(p - 0.5e6),
                    ..hold
                }],
                0.25,
            );
            // (5) Feed +20 % for 10 s, then back (the response comparison's shape).
            let feed_step = run(
                &a,
                eq,
                &[
                    Segment {
                        duration_s: 10.,
                        feed_kg_s: 1.2 * steam,
                        ..hold
                    },
                    Segment {
                        duration_s: 30.,
                        ..hold
                    },
                ],
                0.25,
            );
            let summary = |r: &Value| {
                let (c0, cd, clo, chi) = extremes(r, "collapsed_m");
                let (a0, ad, alo, ahi) = extremes(r, "apparent_m");
                let (n0, nd, nlo, nhi) = extremes(r, "NR_percent");
                let (p0, pd, _, _) = extremes(r, "p_Pa");
                let (m0, md, _, _) = extremes(r, "M_kg");
                json!({"collapsed_m": [c0, cd, clo, chi], "apparent_m": [a0, ad, alo, ahi],
                    "NR_percent": [n0, nd, nlo, nhi], "p_Pa": [p0, pd], "M_kg": [m0, md],
                    "stoppedAt_s": r["stoppedAt_s"], "restarts": r["restarts"].as_array().unwrap().len(),
                    "ida": r["ida"], "startRowsMaxAbs": r["startRowsMaxAbs"]})
            };
            println!(
                "{path} SG.{id}: settled p {p:.1} Pa, V_l {vl:.6} m³, heat {heat:.6e} W, steam {steam}"
            );
            println!("  equilibrium {nominal}");
            for (name, r) in [
                ("relax", &relax),
                ("steam+20%", &steam_step),
                ("heat-90%", &heat_cut),
                ("feed+20%", &feed_step),
            ] {
                println!("  {name}: {}", summary(r));
            }
            sgs.push(json!({"id": id, "settled": {"p_Pa": p, "V_l_m3": vl, "M_kg": m, "U_J": u, "U_rate_W": u_rate,
                    "heat_W": heat, "steam_kg_s": steam, "feedEnthalpy_J_kg": feed_h},
                "equilibrium": nominal, "chartDeterminant": a.chart_determinant(&eq),
                "summary": {"relaxFromPrepared": summary(&relax), "steamPlus20ToMinus05MPa": summary(&steam_step),
                    "heatMinus90ToMinus05MPa": summary(&heat_cut), "feedPlus20For10s": summary(&feed_step)},
                "runs": {"relaxFromPrepared": relax, "steamPlus20ToMinus05MPa": steam_step,
                    "heatMinus90ToMinus05MPa": heat_cut, "feedPlus20For10s": feed_step}}));
        }
        files.push(json!({"state": path, "t_s": state["t_s"], "packet_sha256": state["packet_sha256"], "sgs": sgs}));
    }
    let receipt = json!({
        "lane": "sglevel (C08 apparent level), test-only prototype; NOT S3/S5 evidence",
        "test": "water-ffi/tests/c08_sg_level.rs::settled_state_apparent_level_swells_and_shrinks",
        "section": std::env::var("LD01_C08_SECTION").unwrap(), "packet": packet_path,
        "selection": {"nominalSubmergedVolume_m3": sel.nominal_submerged_m3, "nominalPressure_Pa": sel.nominal_pressure_pa,
            "nominalSteamFlow_kg_s": sel.nominal_steam_kg_s, "maximumSubmergedVolume_m3": sel.maximum_submerged_m3,
            "distributionTime_s": sel.distribution_s, "preparedDistribution": sel.prepared_beta,
            "indicatedLevelArea_m2": sel.area_m2, "nrSpan_m": [sel.nr_low_m, sel.nr_high_m], "nrLag_s": sel.nr_lag_s,
            "residenceTime_s_IF97": residence(&sel)},
        "tolerances": {"relative": 1e-9, "absoluteScaled": 1e-10},
        "wall_s": started.elapsed().as_secs_f64(),
        "files": files,
    });
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
}

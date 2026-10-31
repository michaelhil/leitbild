//! Plan r4 X4.1: a saved S3 state of the packet without the C08 apparent
//! level and the compact feed train, carried onto the composed packet that
//! adds them (`feed_state_onto_the_feed_packet`, ignored; one run per
//! tuple). Every existing coordinate keeps its exact bits, located by the
//! composed operator's labels; only the new coordinates are filled, each by
//! its own row at the saved state:
//! - `M_v = rho_g(p) (V - V_l)`, `V_sub = beta (V - V_l)` and `beta` at its
//!   equilibrium `beta_eq` with the vapor mass rate zero (a settled state);
//! - the header pressure at the pumps' curve for the total branch flow, and
//!   each branch flow equal to that SG's pickup steam (turbine admission at
//!   the saved, untripped state), with its FCV held at the opening that
//!   passes it (the S4-D6 rule at the saved pressure).
//!
//! Rates of the new coordinates are zero. The composition's exact
//! consistent start then makes the start consistent; the conversion claims
//! nothing beyond these rows.
//!
//! Environment: `LD01_OPERATING_HOT_SPINE_PACKET` (the composed packet),
//! `LD01_FEED_FROM_STATE` (the saved state), `LD01_FEED_STATE_OUT`.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::{
    control::feed::Mode,
    joined::packet::Packet,
    sg::{
        packet::Section,
        secondary::{FeedMode, Secondaries, Startup},
    },
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}
fn sha256(bytes: &[u8]) -> String {
    leitbild_operating_plant::digest::sha256(bytes)
}

#[test]
#[ignore = "one conversion per tuple: LD01_FEED_FROM_STATE onto the composed packet"]
fn feed_state_onto_the_feed_packet() {
    let (packet_path, bytes) = common::packet_bytes();
    let raw: Value = serde_json::from_slice(&bytes).unwrap();
    let packet: Packet = serde_json::from_slice(&bytes).unwrap();
    let section: Section = serde_json::from_value(raw["secondary"].clone()).unwrap();
    assert!(section.apparent_level.is_some() && section.feed_train.is_some());
    let owner = Secondaries::new(&section, &packet.thermal.secondaries, &If97).unwrap();
    let apparent = owner.apparent().unwrap();
    let feed = owner.feed().unwrap();
    let from_path = env("LD01_FEED_FROM_STATE");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&from_path).unwrap()).unwrap();
    assert!(
        state["discrete_state"]["operator"]["secondary"]["trip_s"].is_null(),
        "a settled at-power state"
    );
    let bits = |key: &str| -> Vec<f64> {
        state[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| f64::from_bits(u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()))
            .collect()
    };
    let (old_y, old_yp) = (bits("y_bits"), bits("yp_bits"));
    let started = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the S2 composition");
    let joined = started.joined;
    let mut labels = Vec::new();
    for (o, layout) in joined.layouts() {
        for (i, l) in layout.labels.iter().enumerate() {
            labels.push((o, l.clone(), layout.scales[i]));
        }
    }
    let fresh = |o: &str, l: &str| {
        o == "secondary"
            && (l.ends_with(".M_v")
                || l.ends_with(".beta")
                || l.ends_with(".V_sub")
                || l.starts_with("FW."))
    };
    assert_eq!(
        labels.len() - labels.iter().filter(|(o, l, _)| fresh(o, l)).count(),
        old_y.len(),
        "the saved state is the composed packet's without the new coordinates"
    );
    // Old coordinates in order; new ones marked.
    let mut y = Vec::with_capacity(labels.len());
    let mut yp = Vec::with_capacity(labels.len());
    let mut k = 0;
    for (o, l, _) in &labels {
        if fresh(o, l) {
            y.push(f64::NAN);
            yp.push(0.);
        } else {
            y.push(old_y[k]);
            yp.push(old_yp[k]);
            k += 1;
        }
    }
    let at = |label: &str| {
        labels
            .iter()
            .position(|(o, l, _)| *o == "secondary" && l == label)
            .unwrap()
    };
    let phys = |y: &[f64], label: &str| y[at(label)] * labels[at(label)].2;
    let set = |y: &mut Vec<f64>, label: &str, v: f64| {
        let i = at(label);
        y[i] = v / labels[i].2;
    };
    let mut flows = Vec::new();
    let mut openings = Vec::new();
    let mut report = Vec::new();
    for (k, g) in owner.steam_generators().iter().enumerate() {
        let id = &g.id;
        let p = phys(&y, &format!("SG.{id}.p_s"));
        let vl = phys(&y, &format!("SG.{id}.V_l"));
        let gas = g.volume_m3 - vl;
        let sat = WaterProperties::saturation(&If97, Scalar::constant(p)).unwrap();
        let rho_g = sat.vapor.density.value;
        // Settled, untripped, reliefs seated: the withdrawal is the demand.
        let steam = g.steam_demand_kg_s;
        let law = apparent.law(
            Scalar::constant(0.),
            Scalar::constant(steam),
            Scalar::constant(rho_g),
            Scalar::constant(gas),
        );
        let beta = law.beta_eq.value;
        set(&mut y, &format!("SG.{id}.M_v"), rho_g * gas);
        set(&mut y, &format!("SG.{id}.beta"), beta);
        set(&mut y, &format!("SG.{id}.V_sub"), beta * gas);
        set(&mut y, &format!("FW.{id}.m"), steam);
        flows.push((k, steam, p));
        report.push(json!({"sg": id, "p_Pa": p, "V_l_m3": vl, "beta": beta, "V_sub_m3": beta * gas,
            "apparent_level_m": (vl + beta * gas) / apparent.area_m2, "collapsed_level_m": vl / apparent.area_m2}));
    }
    let total: f64 = flows.iter().map(|f| f.1).sum();
    let header = feed.header_pa(Scalar::constant(total)).value;
    set(&mut y, "FW.HEADER.p", header);
    let cascade = feed.train.cascade;
    let m0 = feed.train.nominal_flow_kg_s;
    for (k, m, p) in &flows {
        let u = feed
            .opening_for(*m, header - p)
            .expect("an opening passes the steam flow");
        openings.push(u);
        report[*k]["fcv_opening"] = json!(u);
        // The control at the tracked AUTO point: lags at their inputs.
        let id = &owner.steam_generators()[*k].id;
        let level = report[*k]["apparent_level_m"].as_f64().unwrap();
        let (il, i_f) = cascade.tracked(m0, level, *m, *m, u).unwrap();
        for (label, v) in [
            ("NR1.lag", level),
            ("FT.STEAM.lag", *m),
            ("FW.FT.lag", *m),
            ("IL", il),
            ("IF", i_f),
            ("FCV.u", u),
            ("SF.I", 0.),
            ("SF.u", 0.),
        ] {
            set(&mut y, &format!("FW.{id}.{label}"), v);
        }
    }
    assert!(y.iter().all(|v| v.is_finite()));
    let modes: Vec<FeedMode> = openings
        .iter()
        .map(|u| FeedMode {
            mode: Mode::Auto,
            held: *u,
            startup: Startup::Stopped,
        })
        .collect();
    state["discrete_state"]["operator"]["secondary"]["feed_modes"] = json!(modes);
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    let hex = |v: &[f64]| {
        v.iter()
            .map(|x| format!("{:016x}", x.to_bits()))
            .collect::<Vec<_>>()
    };
    state["y_bits"] = json!(hex(&y));
    state["yp_bits"] = json!(hex(&yp));
    state["packet"] = json!(packet_path);
    state["packet_sha256"] = json!(sha256(&bytes));
    state["converted"] = json!({"from": from_path, "from_sha256": sha256(&std::fs::read(&from_path).unwrap()),
        "rule": "plan r4 X4.1: existing coordinates bitwise by label; C08 at beta_eq with M_v' = 0; feed at the branch flows equal to the steam demand, header on the pump curve, FCV at the opening that passes it; the continuous control at the tracked AUTO point (lags at their inputs, IL and IF by the tracking law)",
        "header_Pa": header, "sgs": report});
    let out = env("LD01_FEED_STATE_OUT");
    std::fs::write(&out, serde_json::to_vec(&state).unwrap()).unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(&state["converted"]).unwrap()
    );
}

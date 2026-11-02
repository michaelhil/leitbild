//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! S3-D32 (lead, 15 Oct): vapor entering a liquid-mode cell is accounted in
//! that cell's totals: subcooled, the vapor has condensed (instantaneous
//! equilibrium condensation, exact); at saturation the cell is born into
//! the equilibrium mode by its existing root. On the S3 base packet's
//! network at C2's configuration: SURGE flashed (equilibrium mode, 0.0126
//! kg of vapor), face 33's vapor path carrying SURGE's vapor into
//! HOT.A.JUNCTION (Π_g = -161.62 Pa·s, C2 at trip + 13.07 s).
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        CellMode, Network, Prepared, Properties, RotorState, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
        unilateral::Lock,
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
/// C2's SURGE vapor at trip + 13.05 s.
const SURGE_VAPOR_KG: f64 = 0.012633242407714245;
const FACE33_VAPOR_IMPULSE: f64 = -161.6193622531661;

struct Setup {
    net: Network<If97>,
    prepared: Prepared,
    y: Vec<f64>,
    surge: usize,
    junction: usize,
    regions: Vec<String>,
}

/// The network at C2's configuration with L1 active: SURGE flashed, face
/// 33's vapor impulse carrying SURGE's vapor into HOT.A.JUNCTION, which is
/// liquid (its vapor slots zero). `junction_departure_k` puts the
/// junction's liquid that far from saturation at its pressure; `stagnant`
/// stops the junction's liquid faces (14, 15, 33), so only vapor arrives.
fn setup(surge_vapor_kg: f64, junction_departure_k: Option<f64>, stagnant: bool) -> Setup {
    let path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let regions: Vec<String> = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let region = |id: &str| regions.iter().position(|r| r == id).unwrap();
    let (surge, junction) = (region("SURGE"), region("HOT.A.JUNCTION"));
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (mut net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y = prepared.y.clone();
    let sc = net.scales().to_vec();
    let ls = net.cell_layout[surge];
    let p = y[ls.base] * sc[ls.base];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let ml = (net.volume(surge) - surge_vapor_kg / rg) * rf;
    net.birth(surge, &mut y).expect("birth");
    y[ls.mass[0]] = (ml + surge_vapor_kg) / sc[ls.mass[0]];
    y[ls.energy[0]] = (ml * uf + surge_vapor_kg * ug) / sc[ls.energy[0]];
    y[ls.mass[1]] = surge_vapor_kg / sc[ls.mass[1]];
    y[ls.energy[1]] = surge_vapor_kg * ug / sc[ls.energy[1]];
    if let Some(departure) = junction_departure_k {
        let lj = net.cell_layout[junction];
        let pj = y[lj.base] * sc[lj.base];
        let tsat = If97
            .saturation_caloric(s(pj))
            .expect("saturation")
            .temperature
            .value;
        // Mass and energy together, so the EOS holds at the cell's pressure.
        let liquid = If97.forward(false, pj, tsat + departure).expect("liquid");
        let mass = net.volume(junction) * liquid.density_kg_m3;
        y[lj.mass[0]] = mass / sc[lj.mass[0]];
        y[lj.energy[0]] = mass * liquid.internal_energy_j_kg / sc[lj.energy[0]];
    }
    if stagnant {
        for face in [14, 15, 33] {
            let i = net.face_layout[2 * face].index;
            y[i] = 0.;
        }
    }
    let i33 = net.face_layout[2 * 33 + 1].index;
    y[i33] = FACE33_VAPOR_IMPULSE / sc[i33];
    let yp = vec![0.; y.len()];
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation");
    let presence = net.declared_presence(&y);
    net.activate_unilateral(&presence).expect("L1 activation");
    assert_eq!(net.unilateral().unwrap().paths[2 * 33 + 1], Lock::Free);
    Setup {
        net,
        prepared,
        y,
        surge,
        junction,
        regions,
    }
}

#[test]
#[ignore = "S3-D32, NOT EVIDENCE: needs the S3 base packet (LD01_PHASE_PACKET) and maintained IF97"]
fn vapor_into_a_subcooled_liquid_cell_condenses_into_its_totals_exactly() {
    let Setup {
        mut net,
        y,
        junction,
        surge,
        ..
    } = setup(SURGE_VAPOR_KG, None, false);
    let sc = net.scales().to_vec();
    let yp = vec![0.; y.len()];
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation");
    let rows: Vec<f64> = net.rows().iter().map(|r| r.value).collect();
    let lj = net.cell_layout[junction];
    // No vapor inventory: the junction's vapor rows see no receipt.
    assert_eq!((rows[lj.mass[1]], rows[lj.energy[1]]), (0., 0.));
    // The junction's liquid receipts are every face's liquid flux plus face
    // 33's vapor flux (with yp = 0 a row is minus its receipt / scale).
    let vapor = net.chart(33, 1).expect("face 33's vapor chart");
    assert!(
        vapor.mass_flow_kg_s.value < 0.,
        "vapor flows from SURGE (to) into the junction (from)"
    );
    // Face fluxes into a cell: (face, phase, +1 where the cell is `to`).
    let sum = |terms: &[(usize, usize, f64)],
               pick: fn(&leitbild_operating_plant::local_flow::Chart) -> f64| {
        terms
            .iter()
            .fold((0., 0.), |(total, scale), (face, k, sign)| {
                let v = sign * pick(&net.chart(*face, *k).expect("chart"));
                (total + v, scale + v.abs())
            })
    };
    // The junction: 14 (UPSTREAM -> JCT, `to`), 15 (JCT -> DOWNSTREAM,
    // `from`), 33 (JCT -> SURGE, `from`), and face 33's vapor.
    let at_junction = [(14, 0, 1.), (15, 0, -1.), (33, 0, -1.), (33, 1, -1.)];
    let (mass_in, mass_scale) = sum(&at_junction, |c| c.mass_flow_kg_s.value);
    let (enthalpy_in, enthalpy_scale) = sum(&at_junction, |c| c.enthalpy_flow_w.value);
    let mass_row = -rows[lj.mass[0]] * sc[lj.mass[0]];
    let energy_row = -rows[lj.energy[0]] * sc[lj.energy[0]];
    assert!(
        (mass_row - mass_in).abs() <= 1e-14 * mass_scale,
        "mass receipt {mass_row} vs {mass_in}"
    );
    // A fixed liquid-only cell's energy rate is its enthalpy receipt.
    assert!(
        (energy_row - enthalpy_in).abs() <= 1e-12 * enthalpy_scale,
        "energy receipt {energy_row} vs {enthalpy_in}"
    );
    // Vapor carries no boron: the junction's tracer receipt is the liquid's.
    assert_eq!(vapor.boron_flow_kg_s.value, 0.);
    let (boron_in, boron_scale) = sum(&at_junction, |c| c.boron_flow_kg_s.value);
    let boron_row = -rows[lj.boron] * sc[lj.boron];
    assert!((boron_row - boron_in).abs() <= 1e-14 * boron_scale);
    // SURGE (equilibrium) loses exactly the vapor the junction takes: its
    // totals' mass row carries face 33's vapor flux with the other sign.
    let ls = net.cell_layout[surge];
    let surge_mass = -rows[ls.mass[0]] * sc[ls.mass[0]];
    let at_surge = [(33, 0, 1.), (33, 1, 1.), (34, 0, -1.), (34, 1, -1.)];
    let (surge_in, surge_scale) = sum(&at_surge, |c| c.mass_flow_kg_s.value);
    assert!((surge_mass - surge_in).abs() <= 1e-14 * surge_scale);
    // The junction stays liquid: 38 K or so subcooled, no birth.
    assert_eq!(net.cell_modes()[junction], CellMode::Liquid);
    let departure = net.liquid_departure(junction, &y).expect("departure");
    assert!(departure < -1., "{departure}");
    println!(
        "{}",
        json!({"vapor_into_junction_kg_s":-vapor.mass_flow_kg_s.value,"vapor_enthalpy_w":-vapor.enthalpy_flow_w.value,
            "junction_liquid_mass_receipt_kg_s":mass_row,"junction_energy_receipt_w":energy_row,"junction_departure_k":departure})
    );
}

#[test]
#[ignore = "S3-D32, NOT EVIDENCE: needs the S3 base packet (LD01_PHASE_PACKET), the wiki, maintained IF97 and stock IDA/KLU"]
fn vapor_driving_a_liquid_cell_to_its_birth_superheat_births_it_by_its_root() {
    use leitbild_operating_plant::network::{PZR_MASS, PZR_TRACER, ToleranceClasses};
    use leitbild_operating_water::{
        ida::{Advance, Ida, Initial},
        network::Integrated,
    };
    // The junction 0.01 K below its birth superheat (G1: the compiled
    // band's creditedMax_K above saturation; the junction lies in the
    // band's pressure range), its liquid faces at rest, fed by SURGE's
    // vapor (5 kg held, so SURGE does not exhaust in the window).
    let credited_k = If97.metastable_band().expect("band").credited_max_k;
    let Setup {
        mut net,
        prepared,
        mut y,
        junction,
        regions,
        ..
    } = setup(5., Some(credited_k - 0.01), true);
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let page = format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
    );
    let text = std::fs::read_to_string(&page).expect("gates page");
    let start = text.find("```ld01-s1-gates\n").expect("gates block") + 16;
    let end = start + text[start..].find("\n```").unwrap();
    let gates: Value = serde_json::from_str(&text[start..end]).expect("gates");
    let f = |k: &str| gates[k].as_f64().unwrap();
    let classes = ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    };
    let atol = net
        .absolute_tolerances(&prepared.y, classes)
        .expect("tolerances");
    let ids = net.differential(&prepared.differential);
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (classes.relative * v.abs() + a))
        .collect();
    let (mut yp, _) =
        consistent_start(&mut net, 0., &mut y, &ids, &weights, 1e-12, 3).expect("consistent start");
    let lj = net.cell_layout[junction];
    assert_eq!((yp[lj.mass[1]], yp[lj.energy[1]]), (0., 0.));
    let d0 = net.liquid_departure(junction, &y).expect("departure");
    let sc = net.scales().to_vec();
    let totals = |net: &Network<If97>, y: &[f64]| -> (f64, f64) {
        let (mut m, mut b) = (0., 0.);
        for c in 0..net.cell_layout.len() {
            let st = net.phase_stocks(c, y);
            m += st[0].0 + st[1].0;
            let i = net.cell_layout[c].boron;
            b += y[i] * sc[i];
        }
        let base = net.pzr.base;
        m += PZR_MASS
            .iter()
            .map(|o| y[base + o] * sc[base + o])
            .sum::<f64>();
        b += PZR_TRACER
            .iter()
            .map(|o| y[base + o] * sc[base + o])
            .sum::<f64>();
        (m, b)
    };
    let before = totals(&net, &y);
    let mut ida = Ida::new(
        Integrated::colored(net).expect("colored structure"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: classes.relative,
        },
    )
    .expect("IDA");
    ida.set_max_order(2).unwrap();
    ida.stop_at(0.5).unwrap();
    let (mut t, mut crossed) = (0., None);
    let mut track = Vec::new();
    while t < 0.5 - 1e-12 {
        match ida.advance(t + 1e-3, &mut y, &mut yp).expect("advance") {
            Advance::Reached(r) => t = r,
            other => panic!("unexpected {other:?}"),
        }
        let net = &ida.system().network;
        // No vapor inventory in the liquid cell, ever.
        assert_eq!((y[lj.mass[1]], y[lj.energy[1]]), (0., 0.), "t = {t}");
        // The birth root (G1: the band's credited superheat above
        // saturation inside its pressure range).
        let d = net.liquid_departure(junction, &y).expect("departure");
        let root = net.birth_root(junction, &y).expect("birth root");
        if track.len() < 400 && (track.len() % 10 == 0 || root > 0.) {
            track.push(json!([t, d, root]));
        }
        if root > 0. {
            crossed = Some((t, d));
            break;
        }
    }
    let (tc, dc) = crossed.expect("the junction reaches its birth superheat");
    let after = totals(&ida.system().network, &y);
    // Mass and boron: the closed network conserves them to the solver's
    // tolerance (vapor became liquid in the junction, nothing was lost).
    assert!(
        ((after.0 - before.0) / before.0).abs() < 1e-7,
        "{before:?} {after:?}"
    );
    assert!(((after.1 - before.1) / before.1.max(1e-9)).abs() < 1e-7);
    // The existing birth root has crossed: the birth transaction takes it.
    let network = &mut ida.system_mut().network;
    let birth = network.birth(junction, &mut y).expect("birth");
    assert_eq!(network.cell_modes()[junction], CellMode::Equilibrium);
    println!(
        "{}",
        json!({"cell":regions[junction],"departure_at_start_k":d0,"crossed_at_s":tc,"departure_k":dc,
            "mass_kg":[before.0, after.0],"boron_kg":[before.1, after.1],"birth":birth,"track":track})
    );
}

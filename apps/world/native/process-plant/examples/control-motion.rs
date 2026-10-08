//! Bounded engineering witness for the same-stage cold mechanical apparatus.
//! Strict Bun-authored physical frame in, retained normal/refined histories out.
use leitbild_plant_numerics::{
    GRAVITY, absorber_fleet as fleet, absorber_motion as motion, dc_supply,
    guide_motion_water as water, operating_network as net,
};
use std::{
    io::{self, Read},
    str::SplitWhitespace,
    time::Instant,
};

fn value<T: std::str::FromStr>(words: &mut SplitWhitespace<'_>) -> Result<T, String> {
    words
        .next()
        .ok_or("Missing control motion frame field")?
        .parse()
        .map_err(|_| "Invalid control motion frame field".into())
}
fn boolean(words: &mut SplitWhitespace<'_>) -> Result<bool, String> {
    match value::<u32>(words)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err("Nonboolean control support path".into()),
    }
}
fn numbers(a: &[f64]) -> String {
    format!(
        "[{}]",
        a.iter()
            .map(|v| format!("{v:.17e}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn supply(words: &mut SplitWhitespace<'_>) -> Result<dc_supply::Supply, String> {
    let c = dc_supply::Config {
        capacity_j: value(words)?,
        normal_group_w: value(words)?,
        charger_limit_w: value(words)?,
        output_limit_w: value(words)?,
        charge_efficiency: value(words)?,
        discharge_efficiency: value(words)?,
        converter_efficiency: value(words)?,
    };
    let energy = value(words)?;
    let paths = dc_supply::Paths {
        charger_available: boolean(words)?,
        battery_available: boolean(words)?,
        output_healthy: boolean(words)?,
    };
    dc_supply::Supply::new(c, energy, paths, true, c.normal_group_w)
}
#[derive(Clone)]
struct Sample {
    state: fleet::State,
    supply: [dc_supply::State; 2],
    head: f64,
    flows: Vec<f64>,
    mass: f64,
    marker: f64,
    temperature: f64,
    energy_defect: f64,
    stage_energy_defect: f64,
    dissipation_defect: f64,
    property_departure: [f64; 4],
}
struct Run {
    samples: Vec<Sample>,
    account: fleet::Account,
    elapsed: f64,
    admitted_property_departure: [f64; 4],
}
fn run(
    model: &water::Model,
    config: &motion::Config,
    mut f: fleet::Fleet,
    rate: f64,
    burst: f64,
    hold: f64,
    a: &fleet::Accuracy,
    deadline: Instant,
) -> Result<Run, String> {
    let start = Instant::now();
    let n = model.config.clusters.len();
    let mut state = fleet::State {
        time_s: 0.,
        motion: vec![
            motion::State {
                body_y_m: 0.,
                body_v_m_s: 0.,
                stem_y_m: 0.,
                stem_v_m_s: 0.,
                reference_y_m: 0.
            };
            n
        ],
        heat: vec![fleet::Heat::default(); n],
        external: model.initial_state()?,
        other_load_export_j: [0.; 2],
    };
    let initial_water_energy = state.external[..model.nodes()].iter().sum::<f64>();
    let original_stage = model.evaluate(&state.motion, &state.external)?;
    let initial_mass = original_stage
        .geometry
        .iter()
        .map(|g| g.volume * model.liquid.density)
        .sum::<f64>();
    let initial_marker = state.external[model.nodes()..].iter().sum::<f64>();
    let mut admitted_property_departure = [0_f64; 4];
    let mut last_report = Instant::now();
    let mut port = |time: f64,
                    s: &[motion::State],
                    e: &[f64],
                    out: &mut fleet::PortRates|
     -> Result<(), String> {
        if Instant::now() >= deadline {
            return Err(format!(
                "Native execution budget reached after {}s wall at trial clock {time}s",
                start.elapsed().as_secs_f64()
            ));
        }
        let stage = model.evaluate(s, e)?;
        if out.admission {
            if last_report.elapsed().as_secs_f64() >= 1. {
                eprintln!(
                    "ADMITTED_PROGRESS time_s={time:.17e} wall_s={:.6} first_motion={:?}",
                    start.elapsed().as_secs_f64(),
                    s.first()
                );
                last_report = Instant::now();
            }
            let current = model.check_property_departure(&stage, 0.05, 0.01)?;
            for (i, v) in current.iter().enumerate() {
                admitted_property_departure[i] = admitted_property_departure[i].max(*v);
            }
        }
        for ((q, r), _) in out.forces.iter_mut().zip(stage.forces).zip(s) {
            q.body_n = r.body_n - config.body_mass_kg * GRAVITY;
            q.stem_n = r.stem_n - config.stem_mass_kg * GRAVITY;
        }
        out.external.copy_from_slice(&stage.rates);
        Ok(())
    };
    let mut samples = Vec::new();
    let record = |s: &fleet::State, f: &fleet::Fleet| -> Result<Sample, String> {
        let stage = model.evaluate(&s.motion, &s.external)?;
        let supplies = f.supply_states(s.time_s)?;
        let mechanical = s
            .motion
            .iter()
            .map(|m| config.mechanical_energy_j(*m, GRAVITY))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .sum::<f64>();
        let heat = s
            .heat
            .iter()
            .map(|h| h.jack_j + h.stem_j + h.spider_j)
            .sum::<f64>();
        let water_energy = s.external[..model.nodes()].iter().sum::<f64>() - initial_water_energy;
        let exports = s.other_load_export_j.iter().sum::<f64>();
        let supplied = supplies.iter().map(|q| q.delivered_j).sum::<f64>();
        let defect = mechanical + heat + water_energy + exports - supplied;
        let bound = 1e-6
            + 4096.
                * f64::EPSILON
                * (mechanical.abs()
                    + heat.abs()
                    + initial_water_energy.abs()
                    + water_energy.abs()
                    + exports
                    + supplied);
        if !defect.is_finite() || defect.abs() > bound {
            return Err(format!(
                "Connected first-law defect {defect} J bound {bound} at {}s",
                s.time_s
            ));
        }
        let mass = stage
            .geometry
            .iter()
            .map(|g| model.liquid.density * g.volume)
            .sum::<f64>();
        let marker = s.external[model.nodes()..].iter().sum::<f64>();
        if (mass - initial_mass).abs() > 128. * f64::EPSILON * initial_mass {
            return Err(format!(
                "Moving geometry mass conservation defect {}kg",
                mass - initial_mass
            ));
        }
        if (marker - initial_marker).abs() > 1e-10 + 256. * f64::EPSILON * initial_marker {
            return Err(format!(
                "Mobile marker conservation defect {}kg",
                marker - initial_marker
            ));
        }
        let departure = model.check_property_departure(&stage, 0.05, 0.01)?;
        let temperature = departure[0];
        Ok(Sample {
            state: s.clone(),
            supply: supplies,
            head: stage.head_pa,
            flows: stage.guide_out_m3_s,
            mass,
            marker,
            temperature,
            energy_defect: defect,
            stage_energy_defect: stage.energy_defect_w,
            dissipation_defect: stage.dissipation_defect_w,
            property_departure: departure,
        })
    };
    macro_rules! checked {
        ($call:expr) => {
            $call.map_err(|error| {
                format!(
                    "{error}\nLAST_ACCEPTED_NATIVE_STATE={state:?}\nFINITE_ACT={:?}\nACCOUNT={:?}\nRETAINED_BRANCHES={:?}",
                    f.supply_states(state.time_s),
                    f.account,
                    f.retained_branches()
                )
            })?
        };
    }
    if checked!(f.command(&state, rate, &mut port)) != fleet::Outcome::Reached {
        return Err("Original full-charge support unavailable".into());
    }
    samples.push(checked!(record(&state, &f)));
    // Common physical observation clocks, not output on every solver step.
    for t in [burst * 0.2, burst * 0.4, burst * 0.6, burst * 0.8, burst] {
        if checked!(f.advance(&mut state, t, a, &mut port)) != fleet::Outcome::Reached {
            return Err("Finite support exhausted during withdrawal".into());
        }
        samples.push(checked!(record(&state, &f)));
    }
    if checked!(f.command(&state, 0., &mut port)) != fleet::Outcome::Reached {
        return Err("Support lost at HOLD".into());
    }
    samples.push(checked!(record(&state, &f)));
    let mut times = vec![
        0.00001, 0.0001, 0.001, 0.002, 0.01, 0.1, 0.5, 1., 2., 5., 10., 20., 40., hold,
    ];
    times.retain(|t| *t <= hold);
    times.sort_by(f64::total_cmp);
    times.dedup();
    for dt in times {
        if checked!(f.advance(&mut state, burst + dt, a, &mut port)) != fleet::Outcome::Reached {
            return Err("Finite support exhausted during HOLD".into());
        }
        samples.push(checked!(record(&state, &f)));
    }
    if state.motion.iter().any(|m| {
        m.body_y_m <= 0. || m.body_v_m_s != 0. || m.stem_v_m_s != 0. || m.body_y_m != m.stem_y_m
    }) || f.account.contact_events < n
        || f.account.contact_heat_j <= 0.
    {
        return Err("Useful withdrawal/HOLD/separation/recontact outcome not achieved".into());
    }
    Ok(Run {
        samples,
        account: f.account,
        elapsed: start.elapsed().as_secs_f64(),
        admitted_property_departure,
    })
}
fn encode(r: &Run) -> String {
    let records=r.samples.iter().map(|q|{
        let states=q.state.motion.iter().map(|m|numbers(&[m.body_y_m,m.body_v_m_s,m.stem_y_m,m.stem_v_m_s,m.reference_y_m])).collect::<Vec<_>>().join(",");
        let heat=q.state.heat.iter().map(|h|numbers(&[h.jack_j,h.stem_j,h.spider_j])).collect::<Vec<_>>().join(",");
        let support=q.supply.iter().map(|s|numbers(&[s.energy_j,s.source_j,s.delivered_j,s.loss_j])).collect::<Vec<_>>().join(",");
        format!("{{\"time_s\":{},\"motion\":[{}],\"heat\":[{}],\"external\":{},\"support\":[{}],\"exports_J\":{},\"head_Pa\":{},\"guide_out_m3_s\":{},\"mass_kg\":{},\"marker_kg\":{},\"maximum_temperature_departure_K\":{},\"energy_defect_J\":{},\"stage_energy_defect_W\":{},\"dissipation_defect_W\":{},\"property_departure\":{}}}",q.state.time_s,states,heat,numbers(&q.state.external),support,numbers(&q.state.other_load_export_j),q.head,numbers(&q.flows),q.mass,q.marker,q.temperature,q.energy_defect,q.stage_energy_defect,q.dissipation_defect,numbers(&q.property_departure))
    }).collect::<Vec<_>>().join(",");
    let a = &r.account;
    format!(
        "{{\"elapsed_s\":{},\"account\":{{\"accepted_steps\":{},\"rejected_steps\":{},\"stage_calls\":{},\"root_steps\":{},\"minimum_accepted_step_s\":{},\"last_accepted_step_s\":{},\"velocity_events\":{},\"separation_events\":{},\"contact_events\":{},\"contact_heat_J\":{},\"root_position_adjustment_m\":{},\"root_velocity_adjustment_m_s\":{},\"root_mechanical_adjustment_J\":{}}},\"maximum_admitted_property_departure\":{},\"samples\":[{}]}}",
        r.elapsed,
        a.accepted_steps,
        a.rejected_steps,
        a.stage_calls,
        a.root_steps,
        a.minimum_accepted_step_s,
        a.last_accepted_step_s,
        a.velocity_events,
        a.separation_events,
        a.contact_events,
        a.contact_heat_j,
        a.maximum_event_position_adjustment_m,
        a.maximum_event_velocity_adjustment_m_s,
        a.event_mechanical_adjustment_j,
        numbers(&r.admitted_property_departure),
        records
    )
}
fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let budget_s: f64 = args
        .next()
        .ok_or("Native control-motion requires an explicit wall budget in seconds")?
        .parse()
        .map_err(|_| "Invalid native execution budget")?;
    if !budget_s.is_finite() || budget_s <= 0. || args.next().is_some() {
        return Err("Invalid native execution budget or trailing argument".into());
    }
    let deadline = Instant::now() + std::time::Duration::from_secs_f64(budget_s);
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let mut w = text.split_whitespace();
    let n: usize = value(&mut w)?;
    if n != 52 {
        return Err("Current complete LD-01 axial witness requires all52 clusters".into());
    }
    let pressure_pa = value(&mut w)?;
    let temperature_k = value(&mut w)?;
    let marker_fraction = value(&mut w)?;
    let pressure_datum_m = value(&mut w)?;
    let lower = water::Bulk {
        volume_m3: value(&mut w)?,
        first_moment_m4: value(&mut w)?,
    };
    let upper = water::Bulk {
        volume_m3: value(&mut w)?,
        first_moment_m4: value(&mut w)?,
    };
    let c = motion::Config {
        body_mass_kg: value(&mut w)?,
        stem_mass_kg: value(&mut w)?,
        force_limit_n: value(&mut w)?,
        grip_closed_force_n: value(&mut w)?,
        gap_stroke_m: value(&mut w)?,
        maximum_rate_m_s: value(&mut w)?,
        efficiency: value(&mut w)?,
        joint_capacity_n: value(&mut w)?,
    };
    let mut g = water::Cluster {
        outer_radius_m: value(&mut w)?,
        body_radius_m: value(&mut w)?,
        bottom_m: value(&mut w)?,
        top_m: value(&mut w)?,
        rodlets: value(&mut w)?,
        body_volume_m3: value(&mut w)?,
        spider_volume_m3: value(&mut w)?,
        stem_volume_m3: value(&mut w)?,
        roughness_m: value(&mut w)?,
        mouth_loss: value(&mut w)?,
        stem_bottom_m: value(&mut w)?,
        stem_top_m: value(&mut w)?,
        stem_radius_m: value(&mut w)?,
        stem_passages: vec![],
    };
    let stem_mean: f64 = value(&mut w)?;
    let spider_mean: f64 = value(&mut w)?;
    if !stem_mean.is_finite() || !spider_mean.is_finite() {
        return Err("Invalid original moving material moment".into());
    }
    let np: usize = value(&mut w)?;
    if np == 0 || np > w.clone().count() / 3 {
        return Err("Invalid actual stem passage count".into());
    }
    for _ in 0..np {
        g.stem_passages.push(water::StemPassage {
            outer_radius_m: value(&mut w)?,
            bottom_m: value(&mut w)?,
            top_m: value(&mut w)?,
        });
    }
    let nr: usize = value(&mut w)?;
    if nr == 0 || nr > w.clone().count() / 8 {
        return Err("Invalid actual return count".into());
    }
    let mut returns = Vec::new();
    for _ in 0..nr {
        let ns: usize = value(&mut w)?;
        if ns == 0 || ns > w.clone().count() / 7 {
            return Err("Invalid return serial segment count".into());
        }
        let mut segments = Vec::new();
        for _ in 0..ns {
            let kind: u32 = value(&mut w)?;
            let length = value(&mut w)?;
            let flow_area = value(&mut w)?;
            let diameter = value(&mut w)?;
            let roughness = value(&mut w)?;
            let fixed_loss = value(&mut w)?;
            let grid_multiplier = value(&mut w)?;
            let law = match kind {
                0 => net::LossLaw::EffectiveTotal,
                1 => net::LossLaw::ChurchillPipe,
                2 => net::LossLaw::ChurchillAnnulus,
                3 => net::LossLaw::CoreBundle,
                4 => net::LossLaw::GuideAnnulus {
                    laminar_darcy: grid_multiplier,
                },
                5 => net::LossLaw::SmoothColebrook,
                _ => return Err("Unsupported current hydraulic family".into()),
            };
            segments.push(net::HydraulicSegment {
                law,
                length,
                flow_area,
                diameter,
                roughness,
                fixed_loss,
                grid_multiplier,
            });
        }
        returns.push(net::Hydraulic {
            from: 0,
            to: n + 1,
            from_elevation: g.bottom_m,
            to_elevation: g.top_m,
            segments,
        });
    }
    // Config.normal_group_w is the base owner; the explicit duty must match.
    let a = supply(&mut w)?;
    let b = supply(&mut w)?;
    let duty = fleet::Duty {
        base_a_w: value(&mut w)?,
        base_b_w: value(&mut w)?,
        holding_w: value(&mut w)?,
        motive_w: value(&mut w)?,
    };
    let rate = value(&mut w)?;
    let burst: f64 = value(&mut w)?;
    let hold: f64 = value(&mut w)?;
    let maximum_step_s = value(&mut w)?;
    let relative = value(&mut w)?;
    let position_m = value(&mut w)?;
    let velocity_m_s = value(&mut w)?;
    let heat_j = value(&mut w)?;
    let water_tol = value(&mut w)?;
    let marker_tol: f64 = value(&mut w)?;
    if w.next().is_some()
        || !burst.is_finite()
        || burst <= 0.
        || burst > 0.5
        || !hold.is_finite()
        || hold <= 0.
        || hold > 60.
    {
        return Err("Trailing input or invalid bounded withdrawal/HOLD request".into());
    }
    let model = water::Model::new(water::Config {
        clusters: vec![g; n],
        lower,
        upper,
        returns,
        pressure_pa,
        temperature_k,
        marker_fraction,
        pressure_datum_m,
    })?;
    let f = fleet::Fleet::new(vec![c; n], a, b, duty)?;
    let mut external_absolute = vec![water_tol; model.nodes()];
    external_absolute.extend(vec![marker_tol; model.nodes()]);
    let accuracy = fleet::Accuracy {
        position_m,
        velocity_m_s,
        heat_j,
        external_absolute,
        relative,
        maximum_step_s,
    };
    let mut tighter = accuracy.clone();
    tighter.position_m *= 0.25;
    tighter.velocity_m_s *= 0.25;
    tighter.heat_j *= 0.25;
    tighter.relative *= 0.25;
    tighter.maximum_step_s *= 0.5;
    for t in &mut tighter.external_absolute {
        *t *= 0.25;
    }
    let normal = run(
        &model,
        &c,
        f.clone(),
        rate,
        burst,
        hold,
        &accuracy,
        deadline,
    )?;
    let refined = run(&model, &c, f, rate, burst, hold, &tighter, deadline)?;
    let mut worst: f64 = 0.;
    let mut locator = String::from("null");
    let mut compare = |quantity: &str, owner: usize, time: f64, u: f64, v: f64, bound: f64| {
        let r = (u - v).abs() / bound;
        if r > worst {
            worst = r;
            locator = format!(
                "{{\"quantity\":\"{}\",\"owner\":{},\"time_s\":{},\"normal\":{},\"tighter\":{},\"difference\":{},\"bound\":{},\"ratio\":{}}}",
                quantity,
                owner,
                time,
                u,
                v,
                (u - v).abs(),
                bound,
                r
            );
        }
    };
    for (a, b) in normal.samples.iter().zip(&refined.samples) {
        if a.state.time_s != b.state.time_s {
            return Err("Paired observations do not share a clock".into());
        }
        for (i, (x, y)) in a.state.motion.iter().zip(&b.state.motion).enumerate() {
            for (name, u, v, bound) in [
                ("body-y-m", x.body_y_m, y.body_y_m, 1e-7),
                ("stem-y-m", x.stem_y_m, y.stem_y_m, 1e-7),
                ("reference-y-m", x.reference_y_m, y.reference_y_m, 1e-7),
                ("body-v-m-s", x.body_v_m_s, y.body_v_m_s, 1e-7),
                ("stem-v-m-s", x.stem_v_m_s, y.stem_v_m_s, 1e-7),
            ] {
                compare(name, i, a.state.time_s, u, v, bound);
            }
        }
        for (i, (x, y)) in a.state.heat.iter().zip(&b.state.heat).enumerate() {
            for (name, u, v) in [
                ("jack-heat-J", x.jack_j, y.jack_j),
                ("stem-impact-heat-J", x.stem_j, y.stem_j),
                ("spider-impact-heat-J", x.spider_j, y.spider_j),
            ] {
                compare(name, i, a.state.time_s, u, v, 1e-5);
            }
        }
        for (i, (x, y)) in a.state.external.iter().zip(&b.state.external).enumerate() {
            let original = normal.samples[0].state.external[i];
            let change = (x - original).abs().max((y - original).abs());
            let (name, bound) = if i < model.nodes() {
                ("water-energy-J", 1e-5 + 1e-3 * change)
            } else {
                ("mobile-marker-kg", 1e-11 + 1e-3 * change)
            };
            compare(name, i % model.nodes(), a.state.time_s, *x, *y, bound);
        }
    }
    if !worst.is_finite() || worst > 1. {
        return Err(format!(
            "Connected normal/refined disagreement {locator}\nNORMAL={}\nTIGHTER={}",
            encode(&normal),
            encode(&refined)
        ));
    }
    println!(
        "{{\"status\":\"PASS\",\"scope\":\"cold-incompressible-mechanical-apparatus-not-source-evolution\",\"pair_policy\":{{\"position_m\":1e-7,\"speed_m_s\":1e-7,\"local_heat_J\":1e-5,\"water_energy_J\":1e-5,\"marker_kg\":1e-11,\"external_actual_change_relative\":1e-3,\"empirical_accuracy_claim\":false}},\"paired_maximum_ratio\":{},\"paired_worst\":{},\"normal\":{},\"tighter\":{}}}",
        worst,
        locator,
        encode(&normal),
        encode(&refined)
    );
    Ok(())
}

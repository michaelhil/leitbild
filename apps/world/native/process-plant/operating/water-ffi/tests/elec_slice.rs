//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#external-carrier-and-operating-grid-join
//! ELEC S3 slice on stock IDAS: turbine admission → torque (declared S3
//! reference-drop reduction), shaft, generator, generator breaker, AC.A/AC.B
//! routing and the quadrature energy receipt. A measurement test of the
//! blocks, NOT a joined-spine case: the admitted steam (the SG owner's law in
//! the joined spine), the turbine-trip/GCB requests (IC-PROT's causes) and the
//! consumer demands are declared inputs here. Parameters come from the
//! operating electrical compiler's packet (ELEC_PACKET).
//!
//! Events: every input change, breaker travel end and AC routing due time is
//! an exact stop. A change of the machine's mode or of a held input is a
//! restart (class R: exact consistent start, IDAReInit, IDAQuadReInit with the
//! accumulated quadratures). The 20 ms Grid receipts are observations (class
//! O): stock interpolation and IDAGetQuad at the returned time, no stop.
#![cfg(feature = "quadratures")]
use leitbild_operating_plant::electrical::{
    breaker::{self, Breaker, Contact},
    bus::{self, Distribution, Source, SourceState},
    slice::{self, Inputs, N, OMEGA, QUADRATURES, Slice},
};
use leitbild_operating_water::ida::{Failure, Ida, Initial, System};
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod common;
use common::cpu;

struct Sys {
    slice: Slice,
    /// Admitted SG steam: held value, or a linear ramp `(t0, t1, m0, m1)`
    /// mirroring the SG owner's STOP ramp in the joined spine.
    ramp: Option<(f64, f64, f64, f64)>,
}
impl Sys {
    fn admit(&mut self, t: f64) {
        if let Some((t0, t1, m0, m1)) = self.ramp {
            let f = ((t - t0) / (t1 - t0)).clamp(0., 1.);
            self.slice.inputs.admitted_kg_s = m0 + (m1 - m0) * f;
        }
    }
}
fn fail(e: String) -> Failure {
    Failure::Fatal(e)
}
impl System for Sys {
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
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.admit(t);
        self.slice.rows(t, y, yp, out).map_err(fail)
    }
    fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.admit(t);
        let g = self.slice.block(cj, y).map_err(fail)?;
        for c in 0..N {
            pointers[c] = (c * N) as i64;
            for r in 0..N {
                data[c * N + r] = g[r][c];
                rows[c * N + r] = r as i64;
            }
        }
        pointers[N] = (N * N) as i64;
        Ok(())
    }
    fn quadrature_count(&self) -> usize {
        QUADRATURES.len()
    }
    fn quadrature(&mut self, t: f64, y: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.admit(t);
        out.copy_from_slice(&self.slice.quadratures(y).map_err(fail)?);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
enum Action {
    /// Manual turbine trip: STOP ramp of admitted steam to zero over
    /// `turbineStop_s`, and a GCB OPEN request (the cold-casing page: a trip
    /// always requests STOP/ADM/RH closure and GCB opening).
    TurbineTrip,
    /// The Grid's offsite connection opens: no stiff boundary and both
    /// auxiliary sources dead (no credited island).
    OffsiteLost,
    /// Admitted steam stepped by a factor (held).
    AdmittedFactor(f64),
}

struct Packet(Value);
impl Packet {
    fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> T {
        serde_json::from_value(self.0[key].clone()).unwrap_or_else(|e| panic!("packet {key}: {e}"))
    }
    fn f(&self, path: &[&str]) -> f64 {
        let mut v = &self.0;
        for p in path {
            v = &v[*p];
        }
        v.as_f64().unwrap_or_else(|| panic!("packet {path:?}"))
    }
}

#[allow(clippy::too_many_lines)]
fn run(packet: &Packet, name: &str, actions: &[(f64, Action)], horizon: f64) -> Value {
    let p: slice::Parameters = packet.get("slice");
    let prepared = &packet.0["prepared"];
    let v_line = packet.f(&["boundary", "lineVoltage_V"]);
    let f0 = packet.f(&["boundary", "frequency_Hz"]);
    let m0 = packet.f(&["prepared", "admittedSteam_kg_s"]);
    let room = packet.f(&["prepared", "room_K"]);
    let stop_s = packet.f(&["steamValveTravel", "turbineStop_s"]);
    let field_demand = packet.f(&["prepared", "fieldDemand_V"]);
    let demands: BTreeMap<String, f64> = packet.get("fixtureConsumerDemand_W");
    let field_bus: String = packet.get("fieldConverterBus");
    let live = SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz: f0,
    };
    let mut routing = Distribution::prepared(
        packet.get::<bus::Parameters>("distribution"),
        [live, live],
        [true, true],
        0.,
    )
    .unwrap();
    let mut gcb = Breaker::new(
        packet.get::<breaker::Parameters>("breaker"),
        Contact::Closed,
    )
    .unwrap();
    let draws = |r: &Distribution| r.source_draw(&demands);
    let d0 = draws(&routing);
    let inputs = Inputs {
        joined: true,
        v_line,
        f_grid_hz: f0,
        carrier_rad_s: slice::prepared_carrier(f0),
        carrier_accel_rad_s2: 0.,
        carrier_from_s: 0.,
        admitted_kg_s: m0,
        field_v: field_demand,
        room_k: room,
        unit_draw_w: d0[0],
        reserve_draw_w: d0[1],
    };
    let sys = Sys {
        slice: Slice::new(p, inputs).unwrap(),
        ramp: None,
    };
    let mut y = vec![0.; N];
    let mut yp = vec![0.; N];
    let flux: Vec<f64> = serde_json::from_value(prepared["initialFlux"].clone()).unwrap();
    y[..3].copy_from_slice(&flux);
    y[OMEGA] = packet.f(&["prepared", "speed_rad_s"]);
    y[slice::THETA] = packet.f(&["prepared", "angle_rad"]);
    y[slice::BODY] = room;
    sys.slice.consistent(0., &mut y, &mut yp).unwrap();
    let e0 = sys.slice.stored_energy(&y);
    let ids = sys.slice.differential();
    let s_flux = v_line / (2. * std::f64::consts::PI * f0);
    let s_cur = packet.f(&["boundary", "base_VA"]) / v_line;
    let field0 = packet.f(&["prepared", "fieldCurrent_A"]);
    // G12: S1's scaled 1e-8 floor times each coordinate's declared scale
    let atol = [
        1e-8 * s_flux,
        1e-8 * s_flux,
        1e-8 * flux[2].abs(),
        1e-8 * s_cur,
        1e-8 * s_cur,
        1e-8 * field0,
        1e-8 * y[OMEGA],
        1e-8,
        1e-8 * room,
    ];
    let mut ida = Ida::new(
        sys,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: 1e-5,
        },
    )
    .unwrap();
    ida.set_max_order(2).unwrap();
    ida.set_nonlinear_convergence_coefficient(0.33).unwrap();
    ida.set_delta_cj_lsetup(0.1).unwrap();
    ida.set_init_step(1e-4).unwrap();
    let mut q = [0.; 10];
    ida.initialize_quadratures(&q).unwrap();
    let mut t: f64 = 0.;
    let mut pending: Vec<(f64, Action)> = actions.to_vec();
    let mut restarts = 0;
    let mut deposits: f64 = 0.;
    let mut arc_heat: f64 = 0.;
    let mut log: Vec<Value> = vec![];
    let mut receipts: Vec<f64> = vec![];
    let mut q_prev: f64 = 0.;
    let mut receipt_k = 1u64;
    let mut next_receipt: f64 = 0.02;
    let (mut steps, mut jac, mut errf, mut newton) = (0i64, 0i64, 0i64, 0i64);
    let mut peak_rpm = 0f64;
    let cpu0 = cpu::thread_cpu_s();
    let mut idle = 0;
    while t < horizon - 1e-12 {
        // next stop: an action, breaker travel end or a routing due time
        let mut stop = horizon;
        for (ta, _) in &pending {
            stop = stop.min(*ta);
        }
        if let Some(b) = gcb.next_event() {
            stop = stop.min(b);
        }
        if let Some(r) = routing.next_event() {
            stop = stop.min(r);
        }
        if let Some((t0, t1, _, _)) = ida.system().ramp {
            for k in [t0, t1] {
                if k > t + 1e-12 {
                    stop = stop.min(k);
                }
            }
        }
        idle = if stop > t + 1e-12 { 0 } else { idle + 1 };
        assert!(idle < 8, "no progress at {t} s");
        if stop > t + 1e-12 {
            ida.stop_at(stop).unwrap();
            // 20 ms receipts as observations inside the segment
            loop {
                let target = next_receipt.min(stop);
                let reached = ida
                    .advance(target, &mut y, &mut yp)
                    .unwrap()
                    .reached()
                    .unwrap();
                peak_rpm = peak_rpm.max(y[OMEGA] * 60. / (2. * std::f64::consts::PI));
                if (reached - next_receipt).abs() < 1e-12 {
                    ida.quadratures(&mut q).unwrap();
                    receipts.push(q[0] - q_prev);
                    q_prev = q[0];
                    receipt_k += 1;
                    next_receipt = receipt_k as f64 * 0.02;
                }
                t = reached;
                if (t - stop).abs() < 1e-12 {
                    break;
                }
            }
        }
        // ---- apply everything due at t, in a fixed order ----
        let logged = routing.records.len();
        ida.current_state(&mut y, &mut yp).unwrap();
        ida.quadratures(&mut q).unwrap();
        let mut changed = false;
        let mut sys_slice = ida.system().slice.clone();
        let mut ramp = ida.system().ramp;
        let mut due: Vec<Action> = vec![];
        pending.retain(|(ta, a)| {
            if (*ta - t).abs() < 1e-12 {
                due.push(*a);
                false
            } else {
                true
            }
        });
        for a in due {
            match a {
                Action::TurbineTrip => {
                    let m = sys_slice.inputs.admitted_kg_s;
                    ramp = Some((t, t + stop_s, m, 0.));
                    gcb.request(Contact::Open, t);
                    log.push(
                        json!({"t": t, "event": "turbine trip: STOP ramp, GCB OPEN requested"}),
                    );
                }
                Action::OffsiteLost => {
                    if sys_slice.inputs.joined {
                        arc_heat += sys_slice.separate(&mut y);
                    }
                    routing
                        .set_source(t, Source::Unit, SourceState::DEAD)
                        .unwrap();
                    routing
                        .set_source(t, Source::Reserve, SourceState::DEAD)
                        .unwrap();
                    log.push(json!({"t": t, "event": "offsite connection lost: stator separated at the boundary, both auxiliary sources dead"}));
                }
                Action::AdmittedFactor(f) => {
                    sys_slice.inputs.admitted_kg_s *= f;
                    log.push(json!({"t": t, "event": format!("admitted steam x{f}")}));
                }
            }
            changed = true;
        }
        if let Some((_, t1, _, m1)) = ramp
            && (t - t1).abs() < 1e-12
        {
            // ramp end: the admission law's kink; hold the end value
            ramp = None;
            sys_slice.inputs.admitted_kg_s = m1;
            changed = true;
        }
        if let Some(c) = gcb.complete(t) {
            if c.contact == Contact::Open && sys_slice.inputs.joined {
                arc_heat += sys_slice.separate(&mut y);
            }
            sys_slice.deposit(&mut y, c.body_heat_j);
            deposits += c.body_heat_j;
            // UNIT_SOURCE: supplied through the closed main contact from the stiff grid only
            if c.contact == Contact::Open {
                routing
                    .set_source(t, Source::Unit, SourceState::DEAD)
                    .unwrap();
            }
            log.push(json!({"t": t, "event": format!("GCB {:?}", c.contact)}));
            changed = true;
        }
        routing.advance(t).unwrap();
        for r in routing.records.iter().skip(logged) {
            log.push(json!({"t": r.time, "event": r.what, "supportChanged": r.support_changed}));
        }
        // field converter on AC.B: delivered fraction scales demand; lost motive -> vf = 0
        let acb = routing
            .bus_energized(routing.bus_index(&field_bus).unwrap())
            .is_some();
        let field_v = if acb { field_demand } else { 0. };
        let d = draws(&routing);
        if field_v != sys_slice.inputs.field_v
            || d[0] != sys_slice.inputs.unit_draw_w
            || d[1] != sys_slice.inputs.reserve_draw_w
        {
            changed = true;
        }
        sys_slice.inputs.field_v = field_v;
        sys_slice.inputs.unit_draw_w = d[0];
        sys_slice.inputs.reserve_draw_w = d[1];
        if changed && t < horizon - 1e-12 {
            // class R: exact consistent start from the retained differential coordinates
            let st = ida.stats().unwrap();
            steps += st.steps;
            jac += st.linear_setups;
            errf += st.error_failures;
            newton += st.nonlinear_iterations;
            {
                let s = ida.system_mut();
                s.slice = sys_slice.clone();
                s.ramp = ramp;
                s.admit(t);
            }
            let sl = ida.system().slice.clone();
            sl.consistent(t, &mut y, &mut yp).unwrap();
            let ids = sl.differential();
            ida.reinitialize(t, &y, &yp).unwrap();
            ida.set_differential(&ids).unwrap();
            ida.reinitialize_quadratures(&q).unwrap();
            restarts += 1;
        }
    }
    let st = ida.stats().unwrap();
    steps += st.steps;
    jac += st.linear_setups;
    errf += st.error_failures;
    newton += st.nonlinear_iterations;
    let cpu = cpu::thread_cpu_s() - cpu0;
    ida.quadratures(&mut q).unwrap();
    let sl = &ida.system().slice;
    let defect = sl.ledger_defect(e0, &y, &q, deposits);
    let telescoped: f64 = receipts.iter().sum();
    let support: BTreeMap<String, Value> = demands
        .keys()
        .map(|k| {
            let s = routing.support(k).unwrap();
            (
                k.clone(),
                json!({"energized": s.energized, "contactorClosed": s.contactor_closed}),
            )
        })
        .collect();
    let result = json!({
        "case": name, "horizon_s": horizon,
        "counts": {"steps": steps, "linear_setups": jac, "error_failures": errf, "newton": newton, "restarts": restarts},
        "cpu_s": cpu,
        "energy": {"quadratures": QUADRATURES.iter().zip(q).map(|(k, v)| (k.to_string(), v)).collect::<BTreeMap<_, _>>(),
            "storedChange_J": sl.stored_energy(&y) - e0, "ledgerDefect_J": defect, "ledgerDefectPerThroughput": defect / [0usize, 1, 2, 3, 4, 5].iter().map(|k| q[*k].abs()).sum::<f64>(), "arcHeat_J": arc_heat, "mechanismDeposits_J": deposits,
            "exportReceipts_20ms": receipts.len(), "receiptSum_J": telescoped, "receiptVsQuadrature_J": telescoped - q[0],
            "netToUnitConnection_J": q[0] - q[8], "reserveImport_J": q[9]},
        "end": {"t": t, "speed_rpm": y[OMEGA] * 60. / (2. * std::f64::consts::PI), "peak_rpm": peak_rpm, "field_A": y[5], "export_W": sl.export_w(&y), "body_K": y[slice::BODY]},
        "support": support,
        "log": log,
    });
    eprintln!(
        "{name}: steps {steps} J {jac} errf {errf} restarts {restarts} ledger defect {defect:.3e} J of |E| {:.3e}, peak {peak_rpm:.2} rpm, cpu {cpu:.3}",
        e0.abs()
    );
    result
}

#[test]
#[ignore = "ELEC S3 slice measurement: run with ELEC_PACKET and ELEC_SLICE_OUT"]
fn elec_s3_slice_on_stock_idas() {
    cpu::prefer_performance_core();
    let path = std::env::var("ELEC_PACKET").expect("ELEC_PACKET");
    let out = std::env::var("ELEC_SLICE_OUT").expect("ELEC_SLICE_OUT");
    let packet = Packet(serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap());
    let cases = vec![
        run(&packet, "HOLD at the prepared sizing point, 30 s", &[], 30.),
        run(
            &packet,
            "ADMIT admitted steam -10 % at 1 s (turbine speed-dependent torque)",
            &[(1., Action::AdmittedFactor(0.9))],
            60.,
        ),
        run(
            &packet,
            "TRIP manual turbine trip at 1 s: STOP ramp, GCB opening, unit→reserve transfer",
            &[(1., Action::TurbineTrip)],
            20.,
        ),
        run(
            &packet,
            "LOOP offsite lost at 1.2345 s; turbine trip and GCB OPEN declared at +0.2 s",
            &[(1.2345, Action::OffsiteLost), (1.4345, Action::TurbineTrip)],
            20.,
        ),
    ];
    let receipt = json!({
        "kind": "ELEC S3 slice on stock IDAS (measurement, NOT evidence)",
        "packet": path, "packetSha256": packet.0["provenance"]["packetSha256"],
        "solver": {"maxOrder": 2, "newtonCoefficient": 0.33, "dcj": 0.1, "initStep_s": 1e-4, "relative": 1e-5, "classes": "G12"},
        "load": cpu::load_average(),
        "cases": cases,
    });
    // Declared ledger criterion: the stored-energy change against the IDAS
    // quadratures (not in the error test) within rtol (1e-5) of the case's
    // energy throughput; the 20 ms receipts telescope to the export quadrature.
    for c in &cases {
        let e = &c["energy"];
        let q = &e["quadratures"];
        let throughput: f64 = [
            "export_W",
            "aero_work_W",
            "oil_heat_W",
            "stator_copper_W",
            "field_copper_W",
            "field_input_W",
        ]
        .iter()
        .map(|k| q[*k].as_f64().unwrap().abs())
        .sum();
        let d = e["ledgerDefect_J"].as_f64().unwrap();
        assert!(
            d.abs() < 1e-5 * throughput,
            "{} ledger defect {d} of throughput {throughput}",
            c["case"]
        );
        assert!(e["receiptVsQuadrature_J"].as_f64().unwrap().abs() < 1e-9 * throughput);
    }
    std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).unwrap();
}

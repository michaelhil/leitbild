//! Strict actual compiled input witness; run explicitly, not a default fixture.
use leitbild_operating_plant::hydraulics::{
    self, CycleIncidence, ForceIncidence, GravityIncidence, Input, MainInertance, MainInput,
    Receipt, Section,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    sections: Vec<Section>,
    inputs: Vec<Input>,
    force_incidence: Vec<ForceIncidence>,
    gravity_incidence: Vec<GravityIncidence>,
    cycle_incidence: Vec<CycleIncidence>,
    edge_pressure_drop_pa: Vec<f64>,
    density_kg_m3: Vec<f64>,
    gravity_m_s2: f64,
    main_inertance: MainInertance,
}

#[test]
#[ignore = "requires LD01_OPERATING_HYDRAULICS actual compiler payload"]
fn actual_compiled_circulation_ports() {
    let file = std::env::var("LD01_OPERATING_HYDRAULICS").expect("explicit actual input path");
    let p: Packet = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    assert_eq!(p.sections.len(), 19);
    assert_eq!(p.inputs.len(), 19);
    assert_eq!(p.density_kg_m3.len(), 26);
    assert_eq!(p.edge_pressure_drop_pa.len(), 32);
    let mut receipt = [Receipt::default(); 19];
    let mut direction = [Receipt::default(); 19];
    let mut maximum_work_defect: f64 = 0.;
    let mut kinetic = 0.;
    for (i, (section, input)) in p.sections.iter().zip(&p.inputs).enumerate() {
        let d = Input {
            massflow_kg_s: input.massflow_kg_s * 0.01,
            density_kg_m3: -input.density_kg_m3 * 0.001,
            viscosity_pa_s: input.viscosity_pa_s * 0.002,
            pressure_drop_pa: 1.,
            omega_rad_s: input.omega_rad_s * 0.003,
            gas_volume_fraction: 0.,
        };
        let a = section.evaluate(*input, d).unwrap();
        receipt[i] = a.value;
        direction[i] = a.direction;
        assert!(a.linearizable);
        assert!(a.value.irreversible_power_w >= 0.);
        let q = input.massflow_kg_s / input.density_kg_m3;
        let defect = a.value.shaft_power_w
            - q * (a.value.pump_euler_pa - a.value.passive_loss_pa)
            - a.value.irreversible_power_w;
        maximum_work_defect = maximum_work_defect.max(defect.abs());
        kinetic += a.value.uniform_kinetic_j;
        assert!(
            defect.abs()
                <= 1e-12
                    * a.value
                        .shaft_power_w
                        .abs()
                        .max(a.value.irreversible_power_w)
                        .max(1.)
        );
    }
    let mut edge = [0.; 32];
    let mut cycles = [0.; 7];
    hydraulics::project_forces(
        &receipt,
        &p.edge_pressure_drop_pa,
        &p.density_kg_m3,
        p.gravity_m_s2,
        &p.force_incidence,
        &p.gravity_incidence,
        &p.cycle_incidence,
        &mut edge,
        &mut cycles,
    )
    .unwrap();
    assert!(cycles.iter().all(|v| v.is_finite()));
    assert!(cycles.iter().any(|v| v.abs() > 100.)); // NOT an equilibrium claim.
    let mut edge_direction = [0.; 32];
    let mut cycle_direction = [0.; 7];
    hydraulics::project_direction(
        &direction,
        &[0.; 32],
        &[-1.; 26],
        p.gravity_m_s2,
        &p.force_incidence,
        &p.gravity_incidence,
        &p.cycle_incidence,
        &mut edge_direction,
        &mut cycle_direction,
    )
    .unwrap();
    assert!(cycle_direction.iter().all(|v| v.is_finite()));
    assert!(cycle_direction.iter().any(|v| v.abs() > 1.));
    // Actual geometric metric and exactly these current forces enter the chart;
    // nonzero split residuals are retained, not solved or asserted balanced.
    let main_current = [
        2. * p.inputs[11].massflow_kg_s,
        2. * p.inputs[16].massflow_kg_s,
    ];
    let momentum = p.main_inertance.momentum(main_current).unwrap();
    let main = p
        .main_inertance
        .evaluate(
            MainInput {
                momentum_pa_s: momentum,
                momentum_rate_pa: [0.; 2],
                cycle_drive_pa: cycles,
            },
            MainInput {
                cycle_drive_pa: cycle_direction,
                ..MainInput::default()
            },
        )
        .unwrap();
    for i in 0..2 {
        assert!((main.current_kg_s[i] - main_current[i]).abs() < 1e-9);
        assert_eq!(main.residual_pa[i], -cycles[i]);
    }
    assert_eq!(&main.residual_pa[2..], &cycles[2..]);
    assert!(p.main_inertance.ab > 0.);
    assert!((p.main_inertance.aa - 70.629211610045).abs() < 1e-11);
    assert!((p.main_inertance.ab - 2.654786439092273).abs() < 1e-12);
    let reversed = [8000., -2500.];
    let mapped = p
        .main_inertance
        .evaluate(
            MainInput {
                momentum_pa_s: p.main_inertance.momentum(reversed).unwrap(),
                ..MainInput::default()
            },
            MainInput::default(),
        )
        .unwrap();
    for (actual, expected) in mapped.current_kg_s.iter().zip(reversed) {
        assert!((actual - expected).abs() < 1e-9);
    }
    // Bounded stage-call timing only; not advancement or four-unit throughput.
    let clock = std::time::Instant::now();
    let mut checksum = 0.;
    for _ in 0..256 {
        for (s, x) in p.sections.iter().zip(&p.inputs) {
            checksum += std::hint::black_box(
                s.evaluate(*x, Input::default())
                    .unwrap()
                    .value
                    .residual_drive_pa,
            );
        }
    }
    assert!(checksum.is_finite());
    let elapsed = clock.elapsed();
    // Fixed-material linear force scales only, not joined dynamic eigenvalues.
    // Two equal parallel branches cancel their factor2 in the I/R estimate.
    let pump_index = 11; // DOWN,8core,HOT.A,SG.A,PUMP.A1.
    assert!(p.sections[pump_index].pump.is_some());
    let d = Input {
        massflow_kg_s: 1.,
        ..Input::default()
    };
    let pump_r = -p.sections[pump_index]
        .evaluate(p.inputs[pump_index], d)
        .unwrap()
        .direction
        .residual_drive_pa;
    let pump_time = (p.sections[pump_index].length_m / p.sections[pump_index].area_m2) / pump_r;
    let core_i = p.sections[1].length_m / p.sections[1].area_m2
        + p.sections[2].length_m / p.sections[2].area_m2;
    let core_r = -(p.sections[1]
        .evaluate(p.inputs[1], d)
        .unwrap()
        .direction
        .residual_drive_pa
        + p.sections[2]
            .evaluate(p.inputs[2], d)
            .unwrap()
            .direction
            .residual_drive_pa);
    eprintln!(
        "actual19-section constitutive calls: K={kinetic:.9}J max localworkdefect={maximum_work_defect:.9e}W; 4864calls={elapsed:?}; mainI={:?} m^-1; conditionalpumpI/R={pump_time:.9}s coreI/R={:.9}s; no trajectory/index admission",
        p.main_inertance,
        core_i / core_r
    );
}

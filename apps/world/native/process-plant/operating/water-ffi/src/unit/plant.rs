//! spec: world/packs/process-plant/reference-designs/ld-01/safety/protection-and-command-precedence.md#time-copies-and-simultaneous-actions
//! The frame-driven S3 unit: a composed [`S3Unit`] on IC-PROT's frame
//! driver with its plant clients — the acquired protection, IC-CTRL's PZR
//! pressure control and (optionally) the generator page's ACT.B field
//! controller (ICFIELD) — in that order, and the test-only Grid stand-in's
//! boundary decided through the driver (owner decisions D1 + D2, S3-D10).
//! The S3 case harness and the C5 host drive this one unit; each adds its
//! own observation-only clients (which decide nothing) after the plant's,
//! and its own observer, case clock and receipts.
use super::s3::S3Unit;
use crate::{
    If97,
    electrical::{Electrified, FieldClient},
    frame::{
        Action, Change, Class, Client, Diagnostic, Driver, Frame, MatrixRebuild, Observer, Reached,
        Setup,
    },
    ic::ProtectionClient,
    ida::Ida,
    joined::{DerivedTolerances, Integrated, JoinedSystem, Restart},
};
use leitbild_operating_plant::{
    electrical::{field, slice},
    ic::packet::Section as IcSection,
};
use serde_json::Value;

/// The frame-driven unit.
pub struct Plant<J: JoinedSystem = Integrated<If97>> {
    pub ida: Ida<Electrified<J>>,
    pub t0: f64,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// The operator's dimension (the slice's coordinates follow).
    pub n: usize,
    pub network_ids: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: f64,
    pub derived: DerivedTolerances,
    pub restart: Restart,
    pub frame: Frame,
    pub driver: Driver<Electrified<J>>,
    pub protection: ProtectionClient,
    pub control: super::pzr_control::PzrClient,
    pub field: Option<FieldClient>,
    /// The composition's receipt.
    pub composition: Value,
    /// The operator at the packet's prepared hot reference (the acquired
    /// protection's references).
    pub reference: Vec<f64>,
}

/// The frame-driven unit's explicit configuration, recorded by its callers'
/// receipts: the field controller's timing (when composed), the driver's
/// residual-jump diagnostic at class-S stops, its matrix management (MR-1's
/// packet interval or stock's own) and its CPU clock.
#[derive(Clone, Copy)]
pub struct Config<'a> {
    pub field: Option<&'a field::Parameters>,
    pub diagnostic: Diagnostic,
    pub matrix_rebuild: MatrixRebuild,
    pub clock: fn() -> f64,
}

/// The Grid stand-in's boundary for an interval `[t0, t1)` (D1, D2 + SW-1).
#[derive(Clone, Copy, Debug)]
pub enum Boundary {
    /// The bus energized at `voltage_v` with the Grid's frequency, its
    /// accepted carrier phase error at `t0` and its frequency rate, held
    /// over the interval.
    Energized {
        voltage_v: f64,
        frequency_hz: f64,
        phase_error_rad: f64,
        frequency_rate_hz_s: f64,
    },
    /// The bus dead (S3-D10's offsite loss).
    Dead,
}

impl<J: JoinedSystem> Plant<J> {
    /// The composed `unit` with the protection of `section`, the field
    /// controller when the configuration gives its timing, and the frame
    /// driver as configured.
    pub fn new(unit: S3Unit<J>, section: &IcSection, config: Config<'_>) -> Result<Self, String> {
        let S3Unit {
            ida,
            t0,
            y,
            yp,
            n,
            network_ids,
            atol,
            rtol,
            derived,
            restart,
            control,
            // The SG owner's continuous feed control needs no plant client
            // (its receipt is the composition's).
            feed_train: _,
            frame,
            stepping,
            receipt,
            reference,
        } = unit;
        let protection = ProtectionClient::new(
            section,
            &ida.system().integrated().joined,
            &y[..n],
            &reference,
        )
        .and_then(|p| p.with_system(ida.system(), y.len()))?;
        let field = config
            .field
            .map(|p| FieldClient::new(p, frame, ida.system()))
            .transpose()?;
        let mut driver = Driver::new(frame, config.diagnostic, config.clock, t0)?;
        driver.matrix_rebuild = config.matrix_rebuild;
        // R4-FREE-STEPS: the composition's own stepping.
        driver.stepping = stepping;
        Ok(Self {
            ida,
            t0,
            y,
            yp,
            n,
            network_ids,
            atol,
            rtol,
            derived,
            restart,
            frame,
            driver,
            protection,
            control,
            field,
            composition: receipt,
            reference,
        })
    }

    /// The driver's frame start at `t0` (the start frame's decisions).
    pub fn start(
        &mut self,
        observers: &mut [&mut dyn Client<Electrified<J>>],
    ) -> Result<(), String> {
        let Self {
            driver,
            protection,
            control,
            field,
            t0,
            y,
            yp,
            ..
        } = self;
        let mut clients = clients(protection, control, field, observers);
        driver.start(&mut clients, *t0, y, yp)
    }

    /// Advance the driver from `t` to `until` (stock one-step mode, every
    /// due change and command applied, every located root restarted), with
    /// `observer` sampled on its grid and both sides of every restart.
    pub fn run(
        &mut self,
        t: f64,
        until: f64,
        observers: &mut [&mut dyn Client<Electrified<J>>],
        observer: Option<&mut dyn Observer<Electrified<J>>>,
    ) -> Result<Reached, String> {
        let Self {
            ida,
            y,
            yp,
            network_ids,
            atol,
            rtol,
            derived,
            restart,
            driver,
            protection,
            control,
            field,
            ..
        } = self;
        let setup = Setup {
            network_ids,
            absolute: atol,
            relative: *rtol,
            restart: *restart,
            derived,
        };
        let mut clients = clients(protection, control, field, observers);
        driver.run_observed(ida, t, until, y, yp, &mut clients, &setup, observer)
    }

    /// Everything due at the driver's time, now (a restart decided there).
    pub fn apply_due(
        &mut self,
        observers: &mut [&mut dyn Client<Electrified<J>>],
    ) -> Result<(), String> {
        let Self {
            ida,
            y,
            yp,
            network_ids,
            atol,
            rtol,
            derived,
            restart,
            driver,
            protection,
            control,
            field,
            ..
        } = self;
        let setup = Setup {
            network_ids,
            absolute: atol,
            relative: *rtol,
            restart: *restart,
            derived,
        };
        let mut clients = clients(protection, control, field, observers);
        driver.apply_due(ida, y, yp, &mut clients, &setup)
    }

    /// The Grid stand-in's boundary for `[t0, t1)`, decided at `t0` through
    /// the driver ([`boundary`]).
    pub fn boundary(&mut self, t0: f64, t1: f64, b: Boundary) -> Result<&'static str, String> {
        boundary(&mut self.driver, self.ida.system(), t0, t1, b)
    }
}

/// The Grid stand-in's boundary for `[t0, t1)`, decided at `t0` (the
/// driver's time) through the driver:
/// - energized, agreeing bitwise with the held inputs (same voltage,
///   frequency and carrier, no slope held or given): no event;
/// - energized otherwise: the held voltage, carrier and slope, a held
///   input entering only the angle's rate row, class S by S3-D4's rule
///   (checked by the driver at the stop);
/// - dead, the first time: S3-D10's offsite loss, class R;
/// - dead again: no change; energized after a loss: refused (no
///   restoration in S3).
///
/// Returns the decision as the receipts name it.
pub fn boundary<J: JoinedSystem>(
    driver: &mut Driver<Electrified<J>>,
    unit: &Electrified<J>,
    t0: f64,
    t1: f64,
    boundary: Boundary,
) -> Result<&'static str, String> {
    let lost = unit.offsite_loss_s.is_some();
    match (boundary, lost) {
        (Boundary::Dead, false) => {
            driver.decide(vec![Change {
                due_s: t0,
                class: Class::R,
                kind: "Grid: bus dead (S3-D10 offsite loss)".into(),
                action: Action::Held(Box::new(move |u: &mut Electrified<J>| {
                    u.offsite_loss_s = Some(t0);
                    Ok(())
                })),
            }])?;
            Ok("R: offsite loss")
        }
        (Boundary::Dead, true) => Ok("dead (unchanged)"),
        (Boundary::Energized { .. }, true) => Err(
            "restoration of a lost offsite connection is not in the S3 slice (S3-D10): refused"
                .into(),
        ),
        (
            Boundary::Energized {
                voltage_v,
                frequency_hz,
                phase_error_rad,
                frequency_rate_hz_s,
            },
            false,
        ) => {
            if !(voltage_v.is_finite() && voltage_v > 0.) {
                return Err(format!("the Grid boundary's voltage {voltage_v} V"));
            }
            // D2: the carrier rate at t0; SW-1: its held slope over [t0, t1).
            let carrier = slice::carrier_rate(frequency_hz, phase_error_rad, t1 - t0)?;
            if !frequency_rate_hz_s.is_finite() {
                return Err(format!(
                    "the Grid boundary's frequency rate {frequency_rate_hz_s} Hz/s"
                ));
            }
            let accel = 2. * std::f64::consts::PI * frequency_rate_hz_s;
            let i = unit.slice.inputs;
            if i.v_line.to_bits() == voltage_v.to_bits()
                && i.f_grid_hz.to_bits() == frequency_hz.to_bits()
                && i.carrier_rad_s.to_bits() == carrier.to_bits()
                && accel == 0.
                && i.carrier_accel_rad_s2 == 0.
            {
                return Ok("none (agrees with the held prediction)");
            }
            driver.decide(vec![Change {
                due_s: t0,
                class: Class::S,
                kind: "Grid boundary (held voltage/carrier and slope, D2 + SW-1)".into(),
                action: Action::Held(Box::new(move |u: &mut Electrified<J>| {
                    u.slice.inputs.v_line = voltage_v;
                    u.slice.inputs.f_grid_hz = frequency_hz;
                    u.slice.inputs.carrier_rad_s = carrier;
                    u.slice.inputs.carrier_accel_rad_s2 = accel;
                    u.slice.inputs.carrier_from_s = t0;
                    Ok(())
                })),
            }])?;
            Ok("S: held boundary")
        }
    }
}

/// The plant's clients in the driver's order (protection, PZR control,
/// field controller), then the caller's observation-only clients.
pub fn clients<'a, J: JoinedSystem>(
    protection: &'a mut ProtectionClient,
    control: &'a mut super::pzr_control::PzrClient,
    field: &'a mut Option<FieldClient>,
    observers: &'a mut [&mut dyn Client<Electrified<J>>],
) -> Vec<&'a mut dyn Client<Electrified<J>>> {
    let mut clients: Vec<&'a mut dyn Client<Electrified<J>>> = vec![protection, control];
    if let Some(f) = field.as_mut() {
        clients.push(f);
    }
    for o in observers.iter_mut() {
        clients.push(&mut **o);
    }
    clients
}

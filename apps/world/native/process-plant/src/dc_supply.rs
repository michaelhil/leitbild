//! Finite regulated DC supply between actual load/path/command/storage events.
//! Exact constant-duty continuation; no battery electrochemistry or voltage curve.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub capacity_j: f64,
    pub normal_group_w: f64,
    pub charger_limit_w: f64,
    pub output_limit_w: f64,
    pub charge_efficiency: f64,
    pub discharge_efficiency: f64,
    pub converter_efficiency: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paths {
    pub charger_available: bool,
    pub battery_available: bool,
    pub output_healthy: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    Overload,
    InsufficientSupply,
    OutputFailure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Reset,
    Close,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State {
    pub time_s: f64,
    pub energy_j: f64,
    pub output_closed: bool,
    pub cause: Option<Cause>,
    pub source_j: f64,
    pub delivered_j: f64,
    pub loss_j: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rates {
    pub charger_dc_w: f64,
    pub energy_w: f64,
    pub source_w: f64,
    pub delivered_w: f64,
    pub loss_w: f64,
}
/// Complete retained supply history. Restoring never prepares a new battery.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Snapshot {
    pub config: Config,
    pub state: State,
    pub paths: Paths,
    pub requested_w: f64,
    pub original_energy_j: f64,
}
#[derive(Clone, Debug)]
pub struct Supply {
    retained: Snapshot,
    rates: Rates,
}
fn finite_nonnegative(v: f64) -> bool {
    v.is_finite() && v >= 0.
}
/// Arithmetic coincidence, not a physical hold-up or grace interval.
pub fn coincident(a: f64, b: f64) -> bool {
    (a - b).abs() <= 4. * f64::EPSILON * a.abs().max(b.abs()).max(1.)
}
impl Config {
    pub fn validate(self) -> Result<Self, String> {
        if [
            self.capacity_j,
            self.normal_group_w,
            self.charger_limit_w,
            self.output_limit_w,
        ]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.)
            || [
                self.charge_efficiency,
                self.discharge_efficiency,
                self.converter_efficiency,
            ]
            .iter()
            .any(|v| !v.is_finite() || *v <= 0. || *v > 1.)
        {
            return Err("Invalid finite DC supply selection".into());
        }
        Ok(self)
    }
}
impl Supply {
    pub fn new(
        config: Config,
        energy_j: f64,
        paths: Paths,
        output_closed: bool,
        requested_w: f64,
    ) -> Result<Self, String> {
        let snapshot = Snapshot {
            config: config.validate()?,
            state: State {
                time_s: 0.,
                energy_j,
                output_closed,
                cause: None,
                source_j: 0.,
                delivered_j: 0.,
                loss_j: 0.,
            },
            paths,
            requested_w,
            original_energy_j: energy_j,
        };
        if !finite_nonnegative(energy_j)
            || energy_j > config.capacity_j
            || !finite_nonnegative(requested_w)
        {
            return Err("Invalid initial DC supply state".into());
        }
        let mut s = Self {
            retained: snapshot,
            rates: Rates::default(),
        };
        s.settle(&[])?;
        s.check_energy(s.retained.state)?;
        Ok(s)
    }
    pub fn restore(retained: Snapshot) -> Result<Self, String> {
        retained.config.validate()?;
        let s = retained.state;
        if [
            s.time_s,
            s.energy_j,
            s.source_j,
            s.delivered_j,
            s.loss_j,
            retained.requested_w,
            retained.original_energy_j,
        ]
        .iter()
        .any(|v| !finite_nonnegative(*v))
            || s.energy_j > retained.config.capacity_j
            || retained.original_energy_j > retained.config.capacity_j
            || (s.output_closed && s.cause.is_some())
        {
            return Err("Invalid retained DC supply history".into());
        }
        let mut out = Self {
            retained,
            rates: Rates::default(),
        };
        out.refresh_rates()?;
        out.check_energy(s)?;
        Ok(out)
    }
    pub fn snapshot(&self) -> Snapshot {
        self.retained
    }
    pub fn paths(&self) -> Paths {
        self.retained.paths
    }
    pub fn rates(&self) -> Rates {
        self.rates
    }
    pub fn requested_w(&self) -> f64 {
        self.retained.requested_w
    }
    fn sufficient(&self, requested: f64) -> bool {
        let r = self.retained;
        let available = if r.paths.charger_available {
            r.config.charger_limit_w
        } else {
            0.
        } + if r.paths.battery_available && r.state.energy_j > 0. {
            r.config.output_limit_w
        } else {
            0.
        };
        r.paths.output_healthy && requested <= r.config.output_limit_w && requested <= available
    }
    pub fn can_deliver(&self, requested: f64) -> bool {
        finite_nonnegative(requested)
            && self.retained.state.output_closed
            && self.sufficient(requested)
    }
    fn settle(&mut self, commands: &[Command]) -> Result<Vec<bool>, String> {
        let mut accepted = Vec::with_capacity(commands.len());
        if self.retained.state.output_closed && !self.sufficient(self.retained.requested_w) {
            self.retained.state.output_closed = false;
            self.retained.state.cause = Some(if !self.retained.paths.output_healthy {
                Cause::OutputFailure
            } else if self.retained.requested_w > self.retained.config.output_limit_w {
                Cause::Overload
            } else {
                Cause::InsufficientSupply
            });
        }
        for command in commands {
            let yes = match command {
                Command::Open => {
                    self.retained.state.output_closed = false;
                    true
                }
                Command::Reset => {
                    let yes = self.sufficient(self.retained.requested_w);
                    if yes {
                        self.retained.state.cause = None;
                    }
                    yes
                }
                Command::Close => {
                    let yes = self.retained.state.cause.is_none()
                        && self.sufficient(self.retained.requested_w);
                    if yes {
                        self.retained.state.output_closed = true;
                    }
                    yes
                }
            };
            accepted.push(yes);
        }
        self.refresh_rates()?;
        Ok(accepted)
    }
    fn refresh_rates(&mut self) -> Result<(), String> {
        let r = self.retained;
        if !finite_nonnegative(r.requested_w) {
            return Err("Invalid requested DC duty".into());
        }
        let load = if r.state.output_closed {
            r.requested_w
        } else {
            0.
        };
        // Restored history must already have accepted its support transition.
        if r.state.output_closed && !self.sufficient(load) {
            return Err("Unsettled DC output support".into());
        }
        let charging = r.paths.battery_available && r.state.energy_j < r.config.capacity_j;
        let charger = if r.paths.charger_available {
            r.config.charger_limit_w.min(
                load + if charging {
                    r.config.charger_limit_w
                } else {
                    0.
                },
            )
        } else {
            0.
        };
        let surplus = (charger - load).max(0.);
        let deficit = (load - charger).max(0.);
        self.rates = Rates {
            charger_dc_w: charger,
            energy_w: r.config.charge_efficiency * surplus
                - deficit / r.config.discharge_efficiency,
            source_w: charger / r.config.converter_efficiency,
            delivered_w: load,
            loss_w: charger * (1. / r.config.converter_efficiency - 1.)
                + (1. - r.config.charge_efficiency) * surplus
                + deficit * (1. / r.config.discharge_efficiency - 1.),
        };
        if [
            self.rates.energy_w,
            self.rates.source_w,
            self.rates.delivered_w,
            self.rates.loss_w,
        ]
        .iter()
        .any(|v| !v.is_finite())
        {
            return Err("Nonfinite DC supply rates".into());
        }
        Ok(())
    }
    pub fn next_storage_event_s(&self) -> Result<Option<f64>, String> {
        let r = self.retained;
        let dt = if self.rates.energy_w > 0. {
            (r.config.capacity_j - r.state.energy_j) / self.rates.energy_w
        } else if self.rates.energy_w < 0. {
            r.state.energy_j * r.config.discharge_efficiency
                / (self.rates.delivered_w - self.rates.charger_dc_w)
        } else {
            return Ok(None);
        };
        let t = r.state.time_s + dt;
        if !t.is_finite() || t <= r.state.time_s {
            return Err("Unresolvable DC storage boundary".into());
        }
        Ok(Some(t))
    }
    /// Left continuation includes the old delivered duty at the exact boundary;
    /// settling paths/commands there determines whether a real outage occurs.
    pub fn at(&self, time_s: f64) -> Result<State, String> {
        let r = self.retained;
        let dt = time_s - r.state.time_s;
        if !time_s.is_finite() || dt < 0. {
            return Err("DC continuation before retained anchor".into());
        }
        let boundary = self.next_storage_event_s()?;
        if boundary.is_some_and(|t| time_s > t && !coincident(time_s, t)) {
            return Err("DC storage boundary crossed without acceptance".into());
        }
        let mut s = r.state;
        s.time_s = time_s;
        s.energy_j += self.rates.energy_w * dt;
        if boundary.is_some_and(|t| coincident(time_s, t)) {
            s.energy_j = if self.rates.energy_w > 0. {
                r.config.capacity_j
            } else {
                0.
            };
        }
        s.source_j += self.rates.source_w * dt;
        s.delivered_j += self.rates.delivered_w * dt;
        s.loss_j += self.rates.loss_w * dt;
        if !finite_nonnegative(s.energy_j) || s.energy_j > r.config.capacity_j {
            return Err("DC continuation exceeded finite storage".into());
        }
        self.check_energy(s)?;
        Ok(s)
    }
    fn check_energy(&self, s: State) -> Result<(), String> {
        let terms = [
            s.energy_j,
            s.delivered_j,
            s.loss_j,
            -s.source_j,
            -self.retained.original_energy_j,
        ];
        let defect = terms.iter().sum::<f64>();
        let bound = 128. * f64::EPSILON * terms.iter().map(|v| v.abs()).sum::<f64>();
        if !defect.is_finite() || defect.abs() > bound {
            return Err(format!("DC energy identity defect {defect} J"));
        }
        Ok(())
    }
    pub fn transition(
        &mut self,
        time_s: f64,
        paths: Paths,
        requested_w: f64,
        commands: &[Command],
    ) -> Result<Vec<bool>, String> {
        let mut candidate = self.clone();
        candidate.retained.state = candidate.at(time_s)?;
        candidate.retained.paths = paths;
        candidate.retained.requested_w = requested_w;
        let accepted = candidate.settle(commands)?;
        *self = candidate;
        Ok(accepted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            capacity_j: 16. * 3.6e6,
            normal_group_w: 2000.,
            charger_limit_w: 10000.,
            output_limit_w: 20000.,
            charge_efficiency: 0.95,
            discharge_efficiency: 0.95,
            converter_efficiency: 0.92,
        }
    }
    fn paths() -> Paths {
        Paths {
            charger_available: false,
            battery_available: true,
            output_healthy: true,
        }
    }
    #[test]
    fn finite_depletion_and_latched_restoration() {
        let mut s = Supply::new(config(), 90000., paths(), true, 2000.).unwrap();
        assert_eq!(s.next_storage_event_s().unwrap(), Some(42.75));
        assert_eq!(s.at(42.75).unwrap().energy_j, 0.);
        s.transition(42.75, paths(), 2000., &[]).unwrap();
        assert_eq!(s.snapshot().state.cause, Some(Cause::InsufficientSupply));
        let restored = Paths {
            charger_available: true,
            ..paths()
        };
        s.transition(60., restored, 1980., &[]).unwrap();
        assert!(!s.can_deliver(1980.));
        assert_eq!(
            s.transition(65., restored, 1980., &[Command::Reset, Command::Close])
                .unwrap(),
            [true, true]
        );
        assert!(s.can_deliver(1980.));
        assert_eq!(s.snapshot().state.energy_j, 47500.);
    }
    #[test]
    fn coincident_charger_arrival_avoids_false_outage() {
        for time in [42.75, 42.75 + 2. * f64::EPSILON * 42.75] {
            let mut s = Supply::new(config(), 90000., paths(), true, 2000.).unwrap();
            s.transition(
                time,
                Paths {
                    charger_available: true,
                    ..paths()
                },
                2000.,
                &[],
            )
            .unwrap();
            assert!(s.can_deliver(2000.));
            assert_eq!(s.snapshot().state.cause, None);
        }
        let mut s = Supply::new(config(), 90000., paths(), true, 2000.).unwrap();
        assert!(s
            .transition(
                42.75 + 1e-6,
                Paths {
                    charger_available: true,
                    ..paths()
                },
                2000.,
                &[]
            )
            .is_err());
        s.transition(42.75, paths(), 2000., &[]).unwrap();
        s.transition(
            42.75 + 1e-6,
            Paths {
                charger_available: true,
                ..paths()
            },
            2000.,
            &[],
        )
        .unwrap();
        assert_eq!(s.snapshot().state.cause, Some(Cause::InsufficientSupply));
    }
    #[test]
    fn full_capacity_ride_through_and_overload_are_actual_finite_laws() {
        let c = config();
        let s = Supply::new(c, c.capacity_j, paths(), true, 2000.).unwrap();
        assert_eq!(s.next_storage_event_s().unwrap(), Some(27360.));
        let s = Supply::new(c, c.capacity_j, paths(), true, c.output_limit_w + 1.).unwrap();
        assert_eq!(s.snapshot().state.cause, Some(Cause::Overload));
        assert_eq!(s.rates().delivered_w, 0.);
    }
    #[test]
    fn full_boundary_throttles_charging_and_battery_failure_keeps_direct_charger() {
        let c = config();
        let p = Paths {
            charger_available: true,
            ..paths()
        };
        let mut s = Supply::new(c, c.capacity_j - 7600., p, true, 2000.).unwrap();
        assert_eq!(s.next_storage_event_s().unwrap(), Some(1.));
        s.transition(1., p, 2000., &[]).unwrap();
        assert_eq!(s.rates().energy_w, 0.);
        let p = Paths {
            battery_available: false,
            ..p
        };
        s.transition(2., p, 2000., &[]).unwrap();
        assert!(s.can_deliver(2000.));
        assert_eq!(s.rates().energy_w, 0.);
    }
    #[test]
    fn restored_snapshot_preserves_all_history_and_refuses_invalid_or_crossed_boundaries() {
        let mut s = Supply::new(config(), 90000., paths(), true, 2000.).unwrap();
        s.transition(20., paths(), 2000., &[]).unwrap();
        let copy = Supply::restore(s.snapshot()).unwrap();
        assert_eq!(s.at(40.).unwrap(), copy.at(40.).unwrap());
        assert_eq!(s.rates(), copy.rates());
        assert!(s.at(43.).is_err());
        let mut bad = s.snapshot();
        bad.state.energy_j = f64::NAN;
        assert!(Supply::restore(bad).is_err());
        bad = s.snapshot();
        bad.state.source_j = 100.;
        assert!(Supply::restore(bad).is_err());
    }
    #[test]
    fn undelivered_request_cannot_disappear_from_reset_and_converter_fault_is_separate() {
        let mut s = Supply::new(
            config(),
            0.,
            Paths {
                charger_available: true,
                ..paths()
            },
            true,
            15000.,
        )
        .unwrap();
        assert_eq!(s.snapshot().state.cause, Some(Cause::InsufficientSupply));
        assert_eq!(
            s.transition(1., s.paths(), 15000., &[Command::Reset, Command::Close])
                .unwrap(),
            [true, true]
        );
        let p = Paths {
            output_healthy: false,
            ..s.paths()
        };
        s.transition(2., p, 15000., &[]).unwrap();
        assert_eq!(s.snapshot().state.cause, Some(Cause::OutputFailure));
        assert_eq!(s.rates().delivered_w, 0.);
    }
}

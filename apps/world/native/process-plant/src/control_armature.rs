//! Finite mechanical opening armature for the selected effective hold-detent
//! reduction. This is not an electromagnetic transient model or an integrator.
//! The armature mass belongs to the existing jack; damping and stop heat have
//! one explicit jack recipient in the composition. Restored HOLD cannot rearm
//! a released mechanism. A failed release retains a real closed constraint.

use crate::GRAVITY;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub mass_kg: f64,
    pub stroke_m: f64,
    pub spring_n_m: f64,
    pub damping_n_s_m: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct State {
    /// Opening displacement, downward positive, from the actual closed stop.
    pub gap_m: f64,
    pub velocity_m_s: f64,
}

/// An accepted release anchor on the composition's sole clock. The component
/// owns no clock and never replaces this anchor with a later numerical trial.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opening {
    pub epoch_time_s: f64,
    pub state: State,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ExactResponse {
    pub state: State,
    /// Cumulative continuous damping since the supplied accepted anchor.
    /// Open-stop heat is a separate once-only contact transaction.
    pub damping_heat_j: f64,
    pub damping_to_jack_w: f64,
    pub acceleration_m_s2: f64,
}

fn compensated(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut sum, mut correction) = (0., 0.);
    for value in values {
        let next = sum + value;
        correction += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    sum + correction
}

/// Integral of exp(rate*s) over [0,time], including the exact zero-rate limit.
fn exponential_integral(rate: f64, time: f64) -> f64 {
    if rate == 0. { time } else { (rate * time).exp_m1() / rate }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Latched,
    /// Mechanical detent remains engaged despite actual loss of HOLD.
    StuckLatched,
    Opening,
    Open,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseFailure {
    None,
    DetentJammed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Response {
    pub gap_rate_m_s: f64,
    pub acceleration_m_s2: f64,
    pub damping_to_jack_w: f64,
    /// Upward constraint reaction. A latched armature has zero constraint work.
    pub detent_reaction_n: f64,
}

impl Config {
    pub fn validate(self) -> Result<(), &'static str> {
        if [self.mass_kg,self.stroke_m,self.spring_n_m,self.damping_n_s_m]
            .iter().any(|x| !x.is_finite() || *x<=0.)
        {
            return Err("Invalid finite control armature");
        }
        Ok(())
    }

    fn finite(self,s: State) -> Result<(), &'static str> {
        self.validate()?;
        if !s.gap_m.is_finite() || !s.velocity_m_s.is_finite() {
            return Err("Nonfinite finite-armature state");
        }
        Ok(())
    }

    /// Absolute retained spring/gravity/kinetic energy. The initially loaded
    /// spring is an actual original stock, not an energy created at release.
    pub fn energy_j(self,s: State) -> Result<f64, &'static str> {
        self.finite(s)?;
        Ok(0.5*self.mass_kg*s.velocity_m_s.powi(2)
            +0.5*self.spring_n_m*(self.stroke_m-s.gap_m).powi(2)
            -self.mass_kg*GRAVITY*s.gap_m)
    }

    pub fn energy_direction_j(self,s: State,ds: State) -> Result<f64, &'static str> {
        self.finite(s)?;
        self.finite(ds)?;
        Ok(self.mass_kg*s.velocity_m_s*ds.velocity_m_s
            -(self.spring_n_m*(self.stroke_m-s.gap_m)+self.mass_kg*GRAVITY)*ds.gap_m)
    }

    /// Exact constant-coefficient Opening solution on the caller's clock.
    /// It continues smoothly through the stop for root trials; only the
    /// existing accepted branch/contact operators admit physical positions.
    /// All positive damping regimes share the same Newton law. Near critical
    /// damping uses its continuous exponential/sinc limit, not a fitted band.
    pub fn exact(self, opening: Opening, time_s: f64) -> Result<ExactResponse, &'static str> {
        self.validate_accepted(opening.state, Mode::Opening)?;
        if !opening.epoch_time_s.is_finite() || opening.epoch_time_s < 0. || !time_s.is_finite()
            || time_s < opening.epoch_time_s
        { return Err("Exact armature requires a finite forward common-clock time"); }
        let elapsed = time_s - opening.epoch_time_s;
        let stiffness = self.spring_n_m / self.mass_kg;
        let damping = self.damping_n_s_m / self.mass_kg;
        let alpha = 0.5 * damping;
        let frequency = stiffness.sqrt();
        let equilibrium = self.stroke_m + GRAVITY / stiffness;
        if !elapsed.is_finite() || ![stiffness, damping, frequency, equilibrium]
            .iter().all(|x| x.is_finite() && *x > 0.)
        { return Err("Unrepresentable exact armature coefficients/time"); }
        let initial = opening.state;
        let offset = initial.gap_m - equilibrium;
        let initial_acceleration = stiffness * (self.stroke_m - initial.gap_m)
            + GRAVITY - damping * initial.velocity_m_s;
        let scale_time = (alpha + frequency) * elapsed;
        let (state, heat) = if elapsed == 0. {
            (initial, 0.)
        } else if scale_time <= 0.5 {
            // Entire-function evaluation, not time integration. In the
            // dimensionless companion matrix the infinity norm is <=1 here;
            // 24 Taylor coefficients leave an exponential remainder <5e-24.
            // Integrating the squared velocity polynomial avoids subtracting
            // O(1 J) energies to recover O(time^3) damping at release.
            const TERMS: usize = 24;
            let mut velocity = [0.; TERMS];
            velocity[0] = initial.velocity_m_s;
            velocity[1] = initial_acceleration * elapsed;
            let a = damping * elapsed;
            let k = (frequency * elapsed).powi(2);
            for n in 0..TERMS - 2 {
                velocity[n + 2] = -(a * (n + 1) as f64 * velocity[n + 1] + k * velocity[n])
                    / ((n + 2) * (n + 1)) as f64;
            }
            let state = State {
                gap_m: initial.gap_m + elapsed * compensated(velocity.iter().enumerate()
                    .map(|(n, &v)| v / (n + 1) as f64)),
                velocity_m_s: compensated(velocity),
            };
            let squared_integral = compensated(velocity.iter().enumerate().flat_map(|(i, &a)|
                velocity.iter().enumerate().map(move |(j, &b)| a * b / (i + j + 1) as f64)));
            (state, self.damping_n_s_m * (elapsed * squared_integral))
        } else {
            let q = alpha * initial.velocity_m_s + stiffness * offset;
            let (ec, es, heat) = if alpha < frequency {
                // e^-alpha*t cos(omega*t), e^-alpha*t sin(omega*t)/omega.
                // Factored difference avoids alpha^2 subtraction near critical.
                let omega = (frequency - alpha).sqrt() * (frequency + alpha).sqrt();
                let phase = omega * elapsed;
                let decay = (-alpha * elapsed).exp();
                let ec = decay * phase.cos();
                let es = decay * elapsed * if phase == 0. { 1. } else { phase.sin() / phase };
                let heat = if omega >= 0.5 * frequency {
                    let beta = 2. * alpha;
                    let phase = 2. * phase;
                    let decay = (-beta * elapsed).exp();
                    let one_minus_cos = -(-beta * elapsed).exp_m1()
                        + decay * 2. * (0.5 * phase).sin().powi(2);
                    let j0 = exponential_integral(-beta, elapsed);
                    let jc = ((alpha / frequency) * one_minus_cos
                        + (omega / frequency) * decay * phase.sin()) / (2. * frequency);
                    let js = ((omega / frequency) * one_minus_cos
                        - (alpha / frequency) * decay * phase.sin()) / (2. * frequency);
                    let p = initial.velocity_m_s;
                    let r = -q / omega;
                    Some(0.5 * self.damping_n_s_m * compensated([
                        (p * p + r * r) * j0,
                        (p * p - r * r) * jc,
                        2. * p * r * js,
                    ]))
                } else { None };
                (ec, es, heat)
            } else if alpha > frequency {
                let beta = (alpha - frequency).sqrt() * (alpha + frequency).sqrt();
                // The slow root's product form does not subtract near-equal
                // alpha/beta; decaying exponentials never form overflowing cosh.
                let fast = -(alpha + beta);
                let slow = -stiffness / (alpha + beta);
                let slow_exp = (slow * elapsed).exp();
                let fast_exp = (fast * elapsed).exp();
                let ec = 0.5 * (slow_exp + fast_exp);
                let phase = beta * elapsed;
                let es = if phase < 0.5 {
                    slow_exp * elapsed * if phase == 0. { 1. }
                        else { -(-2. * phase).exp_m1() / (2. * phase) }
                } else {
                    slow_exp * -(-2. * phase).exp_m1() / (2. * beta)
                };
                let heat = if beta >= 0.5 * alpha {
                    let p = 0.5 * (initial.velocity_m_s - q / beta);
                    let r = 0.5 * (initial.velocity_m_s + q / beta);
                    Some(self.damping_n_s_m * compensated([
                        p * p * 0.5 * exponential_integral(slow, 2. * elapsed),
                        2. * p * r * exponential_integral(-2. * alpha, elapsed),
                        r * r * 0.5 * exponential_integral(fast, 2. * elapsed),
                    ]))
                } else { None };
                (ec, es, heat)
            } else {
                let decay = (-alpha * elapsed).exp();
                (decay, elapsed * decay, None)
            };
            let state = State {
                gap_m: equilibrium + offset * ec + (initial.velocity_m_s + alpha * offset) * es,
                velocity_m_s: initial.velocity_m_s * ec - q * es,
            };
            // In this near-critical/critical branch elapsed*(alpha+omega0)>.5
            // and omega/omega0 or beta/alpha<.5: damping is a resolved fraction
            // of initial mechanical energy. Factor potential differences so
            // no absolute spring-energy datum is subtracted.
            let heat = heat.unwrap_or_else(|| compensated([
                0.5 * self.mass_kg * (initial.velocity_m_s - state.velocity_m_s)
                    * (initial.velocity_m_s + state.velocity_m_s),
                (0.5 * self.spring_n_m * (2. * self.stroke_m - initial.gap_m - state.gap_m)
                    + self.mass_kg * GRAVITY) * (state.gap_m - initial.gap_m),
            ]));
            (state, heat)
        };
        let response = self.evaluate_trial(state, Mode::Opening)?;
        if ![state.gap_m, state.velocity_m_s, heat,
            response.acceleration_m_s2, response.damping_to_jack_w].iter().all(|x| x.is_finite())
            || heat < 0.
        { return Err("Unrepresentable exact armature state/damping"); }
        Ok(ExactResponse { state, damping_heat_j: heat,
            damping_to_jack_w: response.damping_to_jack_w,
            acceleration_m_s2: response.acceleration_m_s2 })
    }

    /// Same retained branch for Newton/root probes. Opening continues smoothly
    /// through a stop for locating it; only validate_accepted admits a state.
    /// Closed/open branches have identically zero RHS, preserving exact stops.
    pub fn evaluate_trial(self,s: State,mode: Mode) -> Result<Response, &'static str> {
        self.finite(s)?;
        let force=self.spring_n_m*(self.stroke_m-s.gap_m)+self.mass_kg*GRAVITY;
        Ok(match mode {
            Mode::Opening => Response {
                gap_rate_m_s:s.velocity_m_s,
                acceleration_m_s2:(force-self.damping_n_s_m*s.velocity_m_s)/self.mass_kg,
                damping_to_jack_w:self.damping_n_s_m*s.velocity_m_s.powi(2),
                detent_reaction_n:0.,
            },
            Mode::Latched | Mode::StuckLatched => Response {
                detent_reaction_n:force,
                ..Response::default()
            },
            Mode::Open => Response::default(),
        })
    }

    pub fn direction(self,s: State,ds: State,mode: Mode) -> Result<Response, &'static str> {
        self.finite(s)?;
        self.finite(ds)?;
        Ok(match mode {
            Mode::Opening => Response {
                gap_rate_m_s:ds.velocity_m_s,
                acceleration_m_s2:(-self.spring_n_m*ds.gap_m
                    -self.damping_n_s_m*ds.velocity_m_s)/self.mass_kg,
                damping_to_jack_w:2.*self.damping_n_s_m*s.velocity_m_s*ds.velocity_m_s,
                detent_reaction_n:0.,
            },
            Mode::Latched | Mode::StuckLatched => Response {
                detent_reaction_n:-self.spring_n_m*ds.gap_m,
                ..Response::default()
            },
            Mode::Open => Response::default(),
        })
    }

    pub fn validate_accepted(self,s: State,mode: Mode) -> Result<(), &'static str> {
        self.finite(s)?;
        let admitted=match mode {
            Mode::Latched | Mode::StuckLatched => s.gap_m==0. && s.velocity_m_s==0.,
            Mode::Opening => (0. ..=self.stroke_m).contains(&s.gap_m) && s.velocity_m_s>=0.,
            Mode::Open => s.gap_m==self.stroke_m && s.velocity_m_s==0.,
        };
        if !admitted {return Err("Finite armature is outside its retained physical branch");}
        Ok(())
    }

    /// The caller supplies actual finite delivered HOLD availability at the
    /// common accepted event. Neither a command nor power restoration is an
    /// armature pose. No state or energy changes in this detent transaction.
    pub fn support_event(self,s: State,mode: Mode,hold_available: bool,failure: ReleaseFailure)
        -> Result<Mode, &'static str>
    {
        self.validate_accepted(s,mode)?;
        Ok(match mode {
            Mode::Latched if !hold_available => match failure {
                ReleaseFailure::None => Mode::Opening,
                ReleaseFailure::DetentJammed => Mode::StuckLatched,
            },
            _ => mode,
        })
    }

    /// Fully inelastic actual open-stop transaction. Root equality must be
    /// established by the caller's existing located-event contract first;
    /// this operator does not snap a pose or invent a numerical tolerance.
    pub fn open_stop(self,s: State,mode: Mode) -> Result<(State,Mode,f64), &'static str> {
        self.validate_accepted(s,mode)?;
        if mode!=Mode::Opening || s.gap_m!=self.stroke_m {
            return Err("Finite armature open stop requires its actual located contact");
        }
        Ok((State {velocity_m_s:0.,..s},Mode::Open,0.5*self.mass_kg*s.velocity_m_s.powi(2)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {mass_kg:1.,stroke_m:0.01,spring_n_m:20_000.,damping_n_s_m:20.}
    }
    #[test]
    fn release_moves_a_finite_mass_and_retains_original_loaded_energy() {
        let c=config();let s=State::default();
        assert_eq!(c.energy_j(s).unwrap(),1.);
        let held=c.evaluate_trial(s,Mode::Latched).unwrap();
        assert_eq!(held.gap_rate_m_s,0.); assert_eq!(held.acceleration_m_s2,0.);
        assert_eq!(held.detent_reaction_n,200.+GRAVITY);
        let mode=c.support_event(s,Mode::Latched,false,ReleaseFailure::None).unwrap();
        assert_eq!(mode,Mode::Opening);assert_eq!(s,State::default());
        let released=c.evaluate_trial(s,mode).unwrap();
        assert_eq!(released.gap_rate_m_s,0.);
        assert_eq!(released.acceleration_m_s2,200.+GRAVITY);
        assert_eq!(c.energy_j(s).unwrap(),1.);
        assert_eq!(c.support_event(s,mode,true,ReleaseFailure::None).unwrap(),Mode::Opening);
    }
    #[test]
    fn jammed_detent_retains_actual_grip_gap_and_does_no_work() {
        let c=config();let s=State::default();
        let mode=c.support_event(s,Mode::Latched,false,ReleaseFailure::DetentJammed).unwrap();
        assert_eq!(mode,Mode::StuckLatched);
        let q=c.evaluate_trial(s,mode).unwrap();
        assert_eq!(q.gap_rate_m_s,0.);assert_eq!(q.acceleration_m_s2,0.);
        assert_eq!(q.damping_to_jack_w,0.);assert_eq!(q.detent_reaction_n,200.+GRAVITY);
        assert_eq!(c.support_event(s,mode,false,ReleaseFailure::None).unwrap(),mode);
        assert_eq!(c.energy_j(s).unwrap(),1.);
    }
    #[test]
    fn exact_opening_energy_identity_and_direction_have_no_free_heat() {
        let c=config();
        for s in [State::default(),State{gap_m:0.004,velocity_m_s:0.7},
            State{gap_m:0.01,velocity_m_s:1.1}]
        {
            let q=c.evaluate_trial(s,Mode::Opening).unwrap();
            let rate=c.energy_direction_j(s,State{gap_m:q.gap_rate_m_s,velocity_m_s:q.acceleration_m_s2}).unwrap();
            let bound=32.*f64::EPSILON*(1.+rate.abs()+q.damping_to_jack_w);
            assert!((rate+q.damping_to_jack_w).abs()<=bound);
            let ds=State{gap_m:-0.003,velocity_m_s:0.2};
            let dq=c.direction(s,ds,Mode::Opening).unwrap();
            let h=1e-5;
            let response=|a:f64|c.evaluate_trial(State{gap_m:s.gap_m+a*ds.gap_m,
                velocity_m_s:s.velocity_m_s+a*ds.velocity_m_s},Mode::Opening).unwrap();
            let a=response(-h);let b=response(h);
            for (fd,exact) in [((b.gap_rate_m_s-a.gap_rate_m_s)/(2.*h),dq.gap_rate_m_s),
                ((b.acceleration_m_s2-a.acceleration_m_s2)/(2.*h),dq.acceleration_m_s2),
                ((b.damping_to_jack_w-a.damping_to_jack_w)/(2.*h),dq.damping_to_jack_w)]
            { assert!((fd-exact).abs()<2e-8*(1.+exact.abs())); }
        }
    }
    #[test]
    fn actual_open_stop_pays_kinetic_energy_once_and_cannot_rearm() {
        let c=config();let s=State{gap_m:c.stroke_m,velocity_m_s:1.2};
        let (after,mode,heat)=c.open_stop(s,Mode::Opening).unwrap();
        assert_eq!(after.gap_m,s.gap_m);assert_eq!(after.velocity_m_s,0.);
        assert_eq!(mode,Mode::Open);assert_eq!(heat,0.72);
        assert!((c.energy_j(s).unwrap()-c.energy_j(after).unwrap()-heat).abs()<4.*f64::EPSILON);
        assert_eq!(c.evaluate_trial(after,mode).unwrap(),Response::default());
        assert!(c.open_stop(after,mode).is_err());
        assert_eq!(c.support_event(after,mode,true,ReleaseFailure::None).unwrap(),Mode::Open);
        assert!(c.open_stop(State{gap_m:c.stroke_m-1e-12,..s},Mode::Opening).is_err());
    }
    #[test]
    fn trial_continuation_does_not_admit_wrong_or_nonfinite_stops() {
        let c=config();let s=State{gap_m:0.0101,velocity_m_s:0.1};
        assert!(c.evaluate_trial(s,Mode::Opening).is_ok());
        assert!(c.validate_accepted(s,Mode::Opening).is_err());
        assert!(c.validate_accepted(State{gap_m:1e-30,..State::default()},Mode::Latched).is_err());
        assert!(c.validate_accepted(State::default(),Mode::Open).is_err());
        assert!(c.evaluate_trial(State{gap_m:f64::NAN,..s},Mode::Opening).is_err());
        assert!(Config{mass_kg:0.,..c}.validate().is_err());
    }

    fn close(a: f64, b: f64, relative: f64) {
        assert!((a - b).abs() <= relative * (1. + a.abs() + b.abs()), "{a:.17e} != {b:.17e}");
    }

    #[test]
    fn exact_zero_tiny_time_and_clock_domain_preserve_the_physical_anchor() {
        let c = config();
        let opening = Opening { epoch_time_s: 32., state: State::default() };
        let zero = c.exact(opening, 32.).unwrap();
        assert_eq!(zero.state, opening.state);
        assert_eq!(zero.damping_heat_j, 0.);
        assert_eq!(zero.damping_to_jack_w, 0.);
        assert_eq!(zero.acceleration_m_s2, 200. + GRAVITY);
        for t in [1e-100_f64, 1e-30, 1e-15, 1e-10, 1e-6] {
            let q = c.exact(Opening { epoch_time_s: 0., ..opening }, t).unwrap();
            let a = 200. + GRAVITY;
            assert!(q.state.gap_m > 0. && q.state.velocity_m_s > 0.);
            assert!(q.damping_heat_j >= 0.);
            close(q.state.velocity_m_s / (a * t), 1., 2e-5);
            if t >= 1e-30 {
                close(q.damping_heat_j / (c.damping_n_s_m * a * a * t.powi(3) / 3.), 1., 2e-5);
            }
        }
        for time in [31.999999, f64::NAN, f64::INFINITY] {
            assert!(c.exact(opening, time).is_err());
        }
        assert!(c.exact(Opening { epoch_time_s: f64::NAN, ..opening }, 32.).is_err());
        assert!(c.exact(Opening { epoch_time_s: -1., ..opening }, 32.).is_err());
        assert!(c.exact(Opening { state: State { gap_m: -1e-12, ..opening.state }, ..opening }, 32.).is_err());
        assert!(c.exact(Opening { state: State { velocity_m_s: -1e-12, ..opening.state }, ..opening }, 32.).is_err());
    }

    #[test]
    fn exact_all_damping_regimes_semigroup_energy_and_local_derivatives() {
        let base = config();
        let critical = 2. * (base.mass_kg * base.spring_n_m).sqrt();
        for damping in [1e-8, 20., critical * (1. - 1e-12), critical,
            critical * (1. + 1e-12), 600., 20_000.] {
            let c = Config { damping_n_s_m: damping, ..base };
            let opening = Opening { epoch_time_s: 0., state: State { gap_m: 0.001, velocity_m_s: 0.2 } };
            for t in [0.0001, 0.002, 0.004, 0.012, 0.04] {
                let q = c.exact(opening, t).unwrap();
                assert!(q.damping_heat_j >= 0.);
                close(c.energy_j(opening.state).unwrap(), c.energy_j(q.state).unwrap() + q.damping_heat_j, 5e-14);
                let h = 1e-7 * t;
                let before = c.exact(opening, t - h).unwrap();
                let after = c.exact(opening, t + h).unwrap();
                close((after.state.gap_m - before.state.gap_m) / (2. * h), q.state.velocity_m_s, 2e-7);
                close((after.state.velocity_m_s - before.state.velocity_m_s) / (2. * h), q.acceleration_m_s2, 2e-7);
                close((after.damping_heat_j - before.damping_heat_j) / (2. * h), q.damping_to_jack_w, 2e-6);
            }
            let first = c.exact(opening, 0.001).unwrap();
            let second = c.exact(Opening { epoch_time_s: 0.001, state: first.state }, 0.003).unwrap();
            let whole = c.exact(opening, 0.003).unwrap();
            close(second.state.gap_m, whole.state.gap_m, 2e-15);
            close(second.state.velocity_m_s, whole.state.velocity_m_s, 2e-14);
            close(first.damping_heat_j + second.damping_heat_j, whole.damping_heat_j, 2e-14);
        }
        let opening = Opening { epoch_time_s: 0., state: State::default() };
        let q = Config { damping_n_s_m: critical, ..base }.exact(opening, 0.01).unwrap();
        for factor in [1. - 1e-12, 1. + 1e-12] {
            let adjacent = Config { damping_n_s_m: critical * factor, ..base }.exact(opening, 0.01).unwrap();
            close(adjacent.state.gap_m, q.state.gap_m, 1e-13);
            close(adjacent.state.velocity_m_s, q.state.velocity_m_s, 1e-12);
            close(adjacent.damping_heat_j, q.damping_heat_j, 1e-12);
        }
    }

    #[test]
    fn exact_open_stop_retains_the_selected_energy_split_and_trial_continuation() {
        let c = config();
        let opening = Opening { epoch_time_s: 0., state: State::default() };
        let (mut low, mut high) = (0., 0.02);
        for _ in 0..60 {
            let mid = 0.5 * (low + high);
            if c.exact(opening, mid).unwrap().state.gap_m < c.stroke_m { low = mid; } else { high = mid; }
        }
        let time = 0.5 * (low + high);
        let q = c.exact(opening, time).unwrap();
        close(time, 0.01126665744, 1e-11);
        close(q.state.velocity_m_s, 1.328579122, 2e-10);
        close(q.damping_heat_j, 0.2155052583, 3e-11);
        let incoming = State { gap_m: c.stroke_m, ..q.state };
        let (after, mode, impact) = c.open_stop(incoming, Mode::Opening).unwrap();
        close(impact, 0.8825612417, 4e-11);
        close(q.damping_heat_j + impact + c.energy_j(after).unwrap(), 1., 5e-14);
        assert_eq!(mode, Mode::Open);
        assert!(c.exact(opening, time + 1e-4).unwrap().state.gap_m > c.stroke_m);
    }

    #[test]
    fn exact_evaluation_branches_are_continuous_not_new_physical_regimes() {
        let base = config();
        let critical = 2. * (base.mass_kg * base.spring_n_m).sqrt();
        let opening = Opening { epoch_time_s: 0., state: State { gap_m: 0.001, velocity_m_s: 0.2 } };
        // Both heat-evaluation transitions and the short-time entire series.
        for damping in [20., critical * 0.75_f64.sqrt(), critical,
            critical / 0.75_f64.sqrt(), 20_000.] {
            let c = Config { damping_n_s_m: damping, ..base };
            let threshold = 0.5 / (0.5 * damping / c.mass_kg + (c.spring_n_m / c.mass_kg).sqrt());
            let before = c.exact(opening, threshold * (1. - 1e-12)).unwrap();
            let after = c.exact(opening, threshold * (1. + 1e-12)).unwrap();
            close(before.state.gap_m, after.state.gap_m, 1e-13);
            close(before.state.velocity_m_s, after.state.velocity_m_s, 1e-12);
            close(before.damping_heat_j, after.damping_heat_j, 2e-12);
        }
        for damping in [critical * 0.75_f64.sqrt(), critical / 0.75_f64.sqrt()] {
            let before = Config { damping_n_s_m: damping * (1. - 1e-12), ..base }.exact(opening, 0.01).unwrap();
            let after = Config { damping_n_s_m: damping * (1. + 1e-12), ..base }.exact(opening, 0.01).unwrap();
            close(before.state.gap_m, after.state.gap_m, 1e-13);
            close(before.state.velocity_m_s, after.state.velocity_m_s, 1e-12);
            close(before.damping_heat_j, after.damping_heat_j, 2e-12);
        }
    }

    #[test]
    fn exact_matches_independent_newton_and_damping_power_integration() {
        let base = config();
        for damping in [20., 2. * (base.mass_kg * base.spring_n_m).sqrt(), 600., 20_000.] {
            let c = Config { damping_n_s_m: damping, ..base };
            let opening = Opening { epoch_time_s: 0., state: State::default() };
            let horizon = 0.004;
            let steps = 12_000;
            let dt = horizon / steps as f64;
            let rhs = |s: [f64; 3]| {
                let force = c.spring_n_m * (c.stroke_m - s[0]) + c.mass_kg * GRAVITY
                    - c.damping_n_s_m * s[1];
                [s[1], force / c.mass_kg, c.damping_n_s_m * s[1] * s[1]]
            };
            let mut state = [0.; 3];
            for _ in 0..steps {
                let a = rhs(state);
                let b = rhs(std::array::from_fn(|j| state[j] + 0.5 * dt * a[j]));
                let d = rhs(std::array::from_fn(|j| state[j] + 0.5 * dt * b[j]));
                let e = rhs(std::array::from_fn(|j| state[j] + dt * d[j]));
                state = std::array::from_fn(|j| state[j] + dt * (a[j] + 2. * b[j] + 2. * d[j] + e[j]) / 6.);
            }
            let q = c.exact(opening, horizon).unwrap();
            close(q.state.gap_m, state[0], 2e-14);
            close(q.state.velocity_m_s, state[1], 2e-12);
            close(q.damping_heat_j, state[2], 2e-13);
        }
    }
}

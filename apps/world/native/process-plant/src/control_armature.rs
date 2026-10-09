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
}

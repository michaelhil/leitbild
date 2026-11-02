//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#breaker-movement-and-passive-opening
//! `LD01.TG.GEN.BREAKER` mechanics as a discrete state, NOT protection or
//! synchrocheck logic. OPEN/CLOSE requests, actual contact, 0.3 s ordinary
//! travel; the contact changes only at the end of travel (a known-time
//! class-R event for the integrator). A full supported close pays 30 J (10 J
//! stocked in the opening spring, 20 J to the breaker body); an opening
//! releases the stocked spring energy into the body. A trip or OPEN abandons
//! a pending CLOSE (the contact never closed). A stuck mechanism retains its
//! contact. Arc heat at separation is the generator's transaction; the body
//! store is the caller's coordinate.

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    #[serde(rename = "travel_s")]
    pub travel_s: f64,
    #[serde(rename = "closingWork_J")]
    pub closing_work_j: f64,
    #[serde(rename = "springStock_J")]
    pub spring_stock_j: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Contact {
    Open,
    Closed,
}

/// A completed travel: the contact change and the mechanism heat for the body.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Completion {
    pub time: f64,
    pub contact: Contact,
    pub body_heat_j: f64,
    /// Closing drive work drawn from the closing supply (ACT.B), J.
    pub drive_work_j: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Breaker {
    pub parameters: Parameters,
    pub contact: Contact,
    pub spring_j: f64,
    pub stuck: bool,
    pending: Option<(Contact, f64)>,
}

/// S3-D19: the breaker's discrete state (contact, opening-spring stock,
/// stuck latch, pending travel), exact (real numbers as IEEE bits).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub contact: Contact,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub spring_j: f64,
    pub stuck: bool,
    #[serde(with = "crate::joined::block::snapshot_bits_pair_option")]
    pub pending: Option<(Contact, f64)>,
}

impl Breaker {
    pub fn discrete_state(&self) -> State {
        State {
            contact: self.contact,
            spring_j: self.spring_j,
            stuck: self.stuck,
            pending: self.pending,
        }
    }
    pub fn restore_discrete_state(&mut self, state: State) {
        self.contact = state.contact;
        self.spring_j = state.spring_j;
        self.stuck = state.stuck;
        self.pending = state.pending;
    }
    pub fn new(parameters: Parameters, contact: Contact) -> Result<Self, String> {
        let p = parameters;
        if !(p.travel_s > 0. && p.closing_work_j >= p.spring_stock_j && p.spring_stock_j >= 0.)
            || ![p.travel_s, p.closing_work_j, p.spring_stock_j]
                .iter()
                .all(|v| v.is_finite())
        {
            return Err(
                "breaker needs positive travel and closing work >= spring stock >= 0".into(),
            );
        }
        // the prepared latched-closed breaker holds its stocked opening spring
        let spring_j = if contact == Contact::Closed {
            p.spring_stock_j
        } else {
            0.
        };
        Ok(Self {
            parameters,
            contact,
            spring_j,
            stuck: false,
            pending: None,
        })
    }
    pub fn pending(&self) -> Option<(Contact, f64)> {
        self.pending
    }
    /// The next known time the contact changes, if any.
    pub fn next_event(&self) -> Option<f64> {
        self.pending.map(|(_, t)| t)
    }
    /// Accept a request at `t`. OPEN abandons a pending CLOSE; a request
    /// for the present contact with nothing pending is a no-op.
    pub fn request(&mut self, target: Contact, t: f64) {
        if self.stuck {
            return;
        }
        match (self.pending, target) {
            (Some((Contact::Closed, _)), Contact::Open) => self.pending = None,
            (Some((pending, _)), _) if pending == target => {}
            (Some(_), _) => {}
            (None, _) if self.contact == target => {}
            (None, _) => self.pending = Some((target, t + self.parameters.travel_s)),
        }
    }
    /// Complete the travel due at `t` (exactly the pending end time).
    pub fn complete(&mut self, t: f64) -> Option<Completion> {
        let (target, end) = self.pending?;
        if t < end {
            return None;
        }
        self.pending = None;
        self.contact = target;
        let p = self.parameters;
        Some(match target {
            Contact::Closed => {
                self.spring_j = p.spring_stock_j;
                Completion {
                    time: end,
                    contact: target,
                    body_heat_j: p.closing_work_j - p.spring_stock_j,
                    drive_work_j: p.closing_work_j,
                }
            }
            Contact::Open => {
                let released = self.spring_j;
                self.spring_j = 0.;
                Completion {
                    time: end,
                    contact: target,
                    body_heat_j: released,
                    drive_work_j: 0.,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p() -> Parameters {
        Parameters {
            travel_s: 0.3,
            closing_work_j: 30.,
            spring_stock_j: 10.,
        }
    }
    #[test]
    fn travel_contact_and_mechanism_energy() {
        let mut b = Breaker::new(p(), Contact::Closed).unwrap();
        b.request(Contact::Open, 1.0);
        assert_eq!(b.next_event(), Some(1.3));
        assert_eq!(b.complete(1.2), None);
        assert_eq!(b.contact, Contact::Closed);
        let c = b.complete(1.3).unwrap();
        assert_eq!((c.contact, c.body_heat_j), (Contact::Open, 10.));
        b.request(Contact::Closed, 2.0);
        b.request(Contact::Open, 2.1); // trip abandons the pending close
        assert_eq!((b.next_event(), b.contact), (None, Contact::Open));
        b.request(Contact::Closed, 3.0);
        let c = b.complete(3.3).unwrap();
        assert_eq!(
            (c.contact, c.body_heat_j, c.drive_work_j),
            (Contact::Closed, 20., 30.)
        );
        b.stuck = true;
        b.request(Contact::Open, 4.0);
        assert_eq!(b.next_event(), None);
    }
    /// S3-D19: a pending travel's end time round-trips exactly.
    #[test]
    fn the_discrete_state_round_trips_exactly() {
        let mut b = Breaker::new(p(), Contact::Closed).unwrap();
        b.request(Contact::Open, 0.1 + 0.2);
        let text = serde_json::to_string(&b.discrete_state()).unwrap();
        let mut c = Breaker::new(p(), Contact::Closed).unwrap();
        c.restore_discrete_state(serde_json::from_str(&text).unwrap());
        assert_eq!(c, b);
        assert_eq!(
            c.next_event().map(f64::to_bits),
            b.next_event().map(f64::to_bits)
        );
        assert!(serde_json::from_str::<State>(&text.replace("stuck", "jammed")).is_err());
    }
}

//! A frame-driven run's events on the case clock (s from the case's t = 0),
//! read from the frame driver's log (one record per instant, with each
//! restart's transaction receipts) and the protection's divisions. Nothing
//! is inferred from prose: each event is a field an owner wrote.
use serde_json::Value;

/// An accepted protection cause in one division.
#[derive(Clone, Debug, PartialEq)]
pub struct Cause {
    pub function: String,
    pub division: usize,
    pub t: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Timeline {
    /// The run's end on the case clock.
    pub end: f64,
    /// Divisions powered at the end (by index).
    pub powered: Vec<bool>,
    pub causes: Vec<Cause>,
    /// Each division's reactor-trip cause, if it tripped.
    pub trips: Vec<Cause>,
    /// Each division's recorded requests (PRHR, CMT, ...), as written.
    pub requests: Vec<(usize, Value)>,
    /// `LD01.TRIP.HOLD` lost (the holding-loss restart).
    pub holding_lost: Option<f64>,
    /// Rod seats: (cluster, t).
    pub seats: Vec<(String, f64)>,
    /// SG relief valves crossing a threshold: (valve, threshold, direction,
    /// t), e.g. `("SG.A.RELIEF.1", "Crack", 1, 1.66)`.
    pub sg_relief: Vec<(String, String, i64, f64)>,
    /// PZR relief demand opening.
    pub pzr_relief_openings: Vec<f64>,
    /// The secondary's STOP ramp end.
    pub stop_ramp_end: Option<f64>,
    /// Every instant: (t, class, kinds).
    pub instants: Vec<(f64, String, Vec<String>)>,
    /// The electrical slice's log (breaker, routing, contactors), when the
    /// slice is composed: `None` when it is not.
    pub electrical: Option<Vec<(f64, String)>>,
}

impl Timeline {
    /// From the driver's `log`, the protection's `divisions` (each
    /// `{powered, causes: [{function, t_s}], trip, requests}`), the holding
    /// loss's absolute time, the case's t = 0 and the run's absolute end.
    pub fn from_logs(
        log: &[Value],
        divisions: &[Value],
        holding_lost: Option<f64>,
        t0: f64,
        end: f64,
    ) -> Result<Self, String> {
        let rel = |v: &Value, what: &str| -> Result<f64, String> {
            v.as_f64()
                .map(|t| t - t0)
                .ok_or_else(|| format!("{what} has no time: {v}"))
        };
        let mut tl = Self {
            end: end - t0,
            holding_lost: holding_lost.map(|t| t - t0),
            ..Self::default()
        };
        for (i, d) in divisions.iter().enumerate() {
            tl.powered.push(d["powered"] == Value::Bool(true));
            for c in d["causes"].as_array().into_iter().flatten() {
                tl.causes.push(Cause {
                    function: c["function"].as_str().unwrap_or_default().to_string(),
                    division: i,
                    t: rel(&c["t_s"], "a cause")?,
                });
            }
            if !d["trip"].is_null() {
                tl.trips.push(Cause {
                    function: d["trip"]["function"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    division: i,
                    t: rel(&d["trip"]["t_s"], "a trip")?,
                });
            }
            for r in d["requests"].as_array().into_iter().flatten() {
                tl.requests.push((i, r.clone()));
            }
        }
        for e in log {
            let t = rel(&e["t_s"], "an instant")?;
            let kinds = e["kinds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect();
            tl.instants.push((
                t,
                e["class"].as_str().unwrap_or_default().to_string(),
                kinds,
            ));
            for x in e["restart"]["transactions"]
                .as_array()
                .into_iter()
                .flatten()
            {
                for r in x["rods"].as_array().into_iter().flatten() {
                    if r["event"] == "seat" {
                        tl.seats.push((
                            r["cluster"].as_str().unwrap_or_default().to_string(),
                            rel(&r["t_s"], "a seat")?,
                        ));
                    }
                }
                if x["owner"] == "secondary" {
                    if x["event"] == "STOP ramp end" {
                        tl.stop_ramp_end = Some(rel(&x["t_s"], "the STOP ramp end")?);
                    }
                    for r in x["relief"].as_array().into_iter().flatten() {
                        tl.sg_relief.push((
                            r["valve"].as_str().unwrap_or_default().to_string(),
                            r["threshold"].as_str().unwrap_or_default().to_string(),
                            r["direction"].as_i64().unwrap_or(0),
                            rel(&x["t_s"], "an SG relief event")?,
                        ));
                    }
                }
                if x["owner"] == "pzr"
                    && x["after"]["demand_open"] == Value::Bool(true)
                    && x["before"]["demand_open"] != Value::Bool(true)
                {
                    tl.pzr_relief_openings
                        .push(rel(&x["t_s"], "a PZR relief opening")?);
                }
            }
        }
        Ok(tl)
    }

    /// The electrical slice's log entries `(absolute t, what)`, on the case
    /// clock.
    #[must_use]
    pub fn with_electrical(mut self, log: &[(f64, String)], t0: f64) -> Self {
        self.electrical = Some(log.iter().map(|(t, w)| (*t - t0, w.clone())).collect());
        self
    }

    /// The electrical events whose text contains `what`.
    pub fn electrical_events(&self, what: &str) -> Option<Vec<(f64, String)>> {
        self.electrical.as_ref().map(|log| {
            log.iter()
                .filter(|(_, w)| w.contains(what))
                .cloned()
                .collect()
        })
    }

    /// The first time `function` was accepted in each division (by index).
    pub fn accepted(&self, function: &str) -> Vec<(usize, f64)> {
        let mut out: Vec<(usize, f64)> = Vec::new();
        for c in self.causes.iter().filter(|c| c.function == function) {
            match out.iter_mut().find(|(d, _)| *d == c.division) {
                Some((_, t)) => *t = t.min(c.t),
                None => out.push((c.division, c.t)),
            }
        }
        out
    }
}

/// The SG a relief valve belongs to, from its name (`SG.<id>.RELIEF.<n>`).
pub fn relief_sg(valve: &str) -> Option<&str> {
    let mut parts = valve.split('.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("SG"), Some(id), Some("RELIEF")) => Some(id),
        _ => None,
    }
}

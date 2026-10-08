//! Strict optional twelfth finite ACT frame. No old-width reader.
use super::super::cooling_actuation::{Event, Plan};
use leitbild_plant_numerics::{dc_supply as dc, prhr_actuator as pa};
pub(super) fn parse(frame: &[&str]) -> Result<Option<Plan>, String> {
    struct Reader<'a> {
        w: &'a [&'a str],
        i: usize,
    }
    impl Reader<'_> {
        fn num(&mut self) -> Result<f64, String> {
            let v = self
                .w
                .get(self.i)
                .ok_or("Truncated ACT frame")?
                .parse::<f64>()
                .map_err(|_| "Invalid ACT number")?;
            self.i += 1;
            if !v.is_finite() {
                return Err("Nonfinite ACT frame".into());
            }
            Ok(v)
        }
        fn bool(&mut self) -> Result<bool, String> {
            match self.num()? {
                0. => Ok(false),
                1. => Ok(true),
                _ => Err("ACT boolean must be 0/1".into()),
            }
        }
        fn change(&mut self) -> Result<Option<bool>, String> {
            match self.num()? {
                -1. => Ok(None),
                0. => Ok(Some(false)),
                1. => Ok(Some(true)),
                _ => Err("ACT path change must be -1/0/1".into()),
            }
        }
        fn count(&mut self) -> Result<usize, String> {
            let n = self.num()?;
            if n < 0. || n.fract() != 0. || n > (self.w.len() - self.i) as f64 {
                return Err("Invalid ACT count".into());
            }
            Ok(n as usize)
        }
    }
    let mut r = Reader { w: frame, i: 0 };
    if !r.bool()? {
        if r.i != frame.len() {
            return Err("Trailing disabled ACT data".into());
        }
        return Ok(None);
    }
    let config = dc::Config {
        capacity_j: r.num()?,
        normal_group_w: r.num()?,
        charger_limit_w: r.num()?,
        output_limit_w: r.num()?,
        charge_efficiency: r.num()?,
        discharge_efficiency: r.num()?,
        converter_efficiency: r.num()?,
    };
    let initial_energy_j = r.num()?;
    let paths = dc::Paths {
        charger_available: r.bool()?,
        battery_available: r.bool()?,
        output_healthy: r.bool()?,
    };
    let output_closed = r.bool()?;
    let count = r.count()?;
    let mut events = Vec::with_capacity(count);
    for _ in 0..count {
        let time = r.num()?;
        let charger = r.change()?;
        let battery = r.change()?;
        let healthy = r.change()?;
        let n = r.count()?;
        let mut commands = Vec::with_capacity(n);
        for _ in 0..n {
            commands.push(match r.num()? {
                0. => dc::Command::Open,
                1. => dc::Command::Reset,
                2. => dc::Command::Close,
                _ => return Err("Unknown ACT output command".into()),
            });
        }
        let prhr_command = match r.num()? {
            -1. => None,
            0. => Some(pa::Command::Open),
            1. => Some(pa::Command::Close),
            _ => return Err("Unknown ACT PRHR command".into()),
        };
        events.push(Event {
            time,
            charger,
            battery,
            healthy,
            commands,
            prhr_command,
        });
    }
    if r.i != frame.len() {
        return Err("Trailing ACT frame data".into());
    }
    let plan = Plan {
        config,
        initial_energy_j,
        paths,
        output_closed,
        events,
    };
    plan.validate()?;
    Ok(Some(plan))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_current_frame_orders_commands_and_refuses_truncation() {
        let text="1 57600000 2000 10000 20000 .95 .95 .92 90000 0 1 1 1 2 60 1 -1 -1 0 -1 65 -1 -1 -1 2 1 2 -1";
        let w = text.split_whitespace().collect::<Vec<_>>();
        let p = parse(&w).unwrap().unwrap();
        assert_eq!(
            p.events[1].commands,
            [dc::Command::Reset, dc::Command::Close]
        );
        for i in 0..w.len() {
            assert!(parse(&w[..i]).is_err());
        }
        let mut extra = w.clone();
        extra.push("0");
        assert!(parse(&extra).is_err());
        let mut bad = w.clone();
        bad[8] = "NaN";
        assert!(parse(&bad).is_err());
        let mut bad = w.clone();
        bad[14] = "300";
        assert!(parse(&bad).is_err());
        assert!(parse(&["0"]).unwrap().is_none());
        assert!(parse(&["0", "0"]).is_err());
    }
}

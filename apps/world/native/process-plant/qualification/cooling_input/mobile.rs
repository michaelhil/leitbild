use leitbild_plant_numerics::mobile_capture::{Input, Path, Recipient, Route, Wall, WallOrigin};
pub(super) fn parse(words: &[&str]) -> Result<Input, String> {
    struct Reader<'a> {
        words: &'a [&'a str],
        position: usize,
    }
    impl Reader<'_> {
        fn value(&mut self) -> Result<f64, String> {
            let v = self
                .words
                .get(self.position)
                .ok_or("Truncated mobile-capture frame")?
                .parse::<f64>()
                .map_err(|_| "Invalid mobile-capture numeric field")?;
            self.position += 1;
            if !v.is_finite() {
                return Err("Nonfinite mobile-capture frame field".into());
            }
            Ok(v)
        }
        fn count(&mut self) -> Result<usize, String> {
            let text = self
                .words
                .get(self.position)
                .ok_or("Truncated mobile-capture count")?;
            self.position += 1;
            text.parse()
                .map_err(|_| "Invalid mobile-capture integer field".into())
        }
        fn bounded(&mut self, width: usize) -> Result<usize, String> {
            let n = self.count()?;
            if n > (self.words.len() - self.position) / width {
                return Err("Mobile-capture count exceeds frame".into());
            }
            Ok(n)
        }
    }
    let mut w = Reader { words, position: 0 };
    let water_mu = [w.value()?, w.value()?];
    let count = w.bounded(2)?;
    let mut wall_origins = Vec::with_capacity(count);
    for _ in 0..count {
        let unrepresented_wall_share = w.value()?;
        let count = w.bounded(2)?;
        let mut paths = Vec::with_capacity(count);
        for _ in 0..count {
            let share = w.value()?;
            let count = w.bounded(6)?;
            let mut stages = Vec::with_capacity(count);
            for _ in 0..count {
                let kind = w.count()?;
                let index = w.count()?;
                let recipient = match (kind, index) {
                    (0, i) => Recipient::Clad(i),
                    (1, 0) => Recipient::Barrel,
                    (2, i) => Recipient::Host(i),
                    _ => return Err("Unknown mobile-capture finite wall recipient".into()),
                };
                stages.push(Wall {
                    recipient,
                    thickness_m: w.value()?,
                    density_kg_m3: w.value()?,
                    mu: [w.value()?, w.value()?],
                });
            }
            paths.push(Path { share, stages });
        }
        wall_origins.push(WallOrigin {
            unrepresented_wall_share,
            paths,
        });
    }
    let count = w.bounded(5)?;
    let mut routes = Vec::with_capacity(count);
    for _ in 0..count {
        let route = Route {
            region: w.count()?,
            water: w.count()?,
            birth_share: w.value()?,
            liquid_chord_m: w.value()?,
            wall_origin: w.count()?,
        };
        if route.wall_origin >= wall_origins.len() {
            return Err("Foreign mobile-capture wall origin".into());
        }
        routes.push(route);
    }
    if w.position != words.len() {
        return Err("Trailing mobile-capture frame".into());
    }
    Ok(Input {
        water_mu,
        wall_origins,
        routes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_counts_truncation_nonfinite_and_old_shape() {
        for text in [
            "",
            "1 2",
            "1 NaN 0",
            "1 2 99999999999999999999",
            "1 2 0 9",
            "1 2 1 0 0 1 1 0 1 1 1 4 0 1 1 1 1",
            "1 2 1 0 0 1 1 0 1 1 2",
        ] {
            assert!(
                parse(&text.split_whitespace().collect::<Vec<_>>()).is_err(),
                "{text}"
            );
        }
        assert!(parse(&["1", "2", "0", "0"]).is_ok());
    }
}

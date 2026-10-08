//! Explicit numerical projection of the consumed fixed-cold BODY/guide owners.
//! Material/source validity belongs to the native constructor; this boundary
//! rejects malformed, nonfinite, truncated and trailing wire fields.
use leitbild_plant_numerics::absorber_guide::{
    Axial, Body, Caloric, Contact, GuideBirth, Host, Input, Photons,
};

struct Reader<'a> {
    words: &'a [&'a str],
    position: usize,
}
impl Reader<'_> {
    fn value(&mut self) -> Result<f64, String> {
        let text = self
            .words
            .get(self.position)
            .ok_or("Truncated BODY/guide numeric field")?;
        self.position += 1;
        let value = text
            .parse::<f64>()
            .map_err(|_| "Invalid BODY/guide numeric field")?;
        if !value.is_finite() {
            return Err("Nonfinite BODY/guide numeric field".into());
        }
        Ok(value)
    }
    fn index(&mut self) -> Result<usize, String> {
        let text = self
            .words
            .get(self.position)
            .ok_or("Truncated BODY/guide integer field")?;
        self.position += 1;
        text.parse()
            .map_err(|_| "Invalid BODY/guide integer field".into())
    }
    fn count(&mut self, width: usize) -> Result<usize, String> {
        let count = self.index()?;
        if count > (self.words.len() - self.position) / width {
            return Err("BODY/guide count exceeds frame".into());
        }
        Ok(count)
    }
}

pub(super) fn parse(words: &[&str]) -> Result<Input, String> {
    let mut r = Reader { words, position: 0 };
    let mut caloric = Caloric {
        steel_cp0: r.value()?,
        steel_cp1: r.value()?,
        datum_k: r.value()?,
        body_min_k: r.value()?,
        body_max_k: r.value()?,
        guide_min_k: r.value()?,
        guide_max_k: r.value()?,
        b4c_cp_points: Vec::new(),
    };
    for _ in 0..r.count(2)? {
        caloric.b4c_cp_points.push([r.value()?, r.value()?]);
    }
    let wet_h = r.value()?;
    let photons = Photons {
        density_b4c: r.value()?,
        density_steel: r.value()?,
        density_zr: r.value()?,
        mu_b4c_05: r.value()?,
        mu_steel_05: r.value()?,
        mu_steel_1: r.value()?,
        mu_zr_1: r.value()?,
        mu_water_05: r.value()?,
        mu_water_1: r.value()?,
        guide_chord_m: r.value()?,
        guide_capture_j: r.value()?,
    };
    let mut hosts = Vec::new();
    for _ in 0..r.count(4)? {
        hosts.push(Host {
            b4c_mass_kg: r.value()?,
            steel_mass_kg: r.value()?,
            zr_mass_kg: r.value()?,
            initial_k: r.value()?,
        });
    }
    let mut contacts = Vec::new();
    for _ in 0..r.count(5)? {
        contacts.push(Contact {
            host: r.index()?,
            water: r.index()?,
            area_m2: r.value()?,
            solid_geometry_m_inv: r.value()?,
            liquid_chord_m: r.value()?,
        });
    }
    let mut axial = Vec::new();
    for _ in 0..r.count(3)? {
        axial.push(Axial {
            a: r.index()?,
            b: r.index()?,
            area_over_distance_m: r.value()?,
        });
    }
    let mut bodies = Vec::new();
    for _ in 0..r.count(16)? {
        bodies.push(Body {
            host: r.index()?,
            targets: [r.index()?, r.index()?, r.index()?, r.index()?, r.index()?],
            capture_j: [r.value()?, r.value()?, r.value()?, r.value()?, r.value()?],
            b_photon_j: r.value()?,
            mn_owner: r.index()?,
            b4c_chord_m: r.value()?,
            steel_chord_m: r.value()?,
            steel_shell_m: r.value()?,
        });
    }
    let mut guide_births = Vec::new();
    for _ in 0..r.count(4)? {
        guide_births.push(GuideBirth {
            target: r.index()?,
            region: r.index()?,
            host: r.index()?,
            share: r.value()?,
        });
    }
    if r.position != words.len() {
        return Err("Trailing BODY/guide frame".into());
    }
    Ok(Input {
        caloric,
        wet_h,
        photons,
        hosts,
        contacts,
        axial,
        bodies,
        guide_births,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Distinct values make a swapped field or BODY-record width visible.
    fn frame() -> Vec<String> {
        let mut words = [
            1., 2., 300., 290., 1600., 290., 1800., 2., 200., 20., 1600., 130., 250.,
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        words.extend((1..=11).map(|v| v.to_string()));
        words.extend("1 14 15 0 293 1 0 7 18 19 20 1 0 1 21 1 0 1 2 3 4 5 26 27 28 29 30 31 6 33 34 35 1 8 9 0 0.5"
            .split_whitespace().map(str::to_owned));
        words
    }
    fn read(words: &[String]) -> Result<Input, String> {
        parse(&words.iter().map(String::as_str).collect::<Vec<_>>())
    }
    #[test]
    fn preserves_exact_explicit_scalar_order_and_integer_ownership() {
        let input = read(&frame()).unwrap();
        assert_eq!(
            input.caloric.b4c_cp_points,
            vec![[200., 20.], [1600., 130.]]
        );
        assert_eq!(input.photons.density_b4c, 1.);
        assert_eq!(input.photons.guide_capture_j, 11.);
        assert_eq!(input.hosts[0].steel_mass_kg, 15.);
        assert_eq!(input.contacts[0].water, 7);
        assert_eq!(input.contacts[0].liquid_chord_m, 20.);
        assert_eq!(input.axial[0].area_over_distance_m, 21.);
        assert_eq!(input.bodies[0].targets, [1, 2, 3, 4, 5]);
        assert_eq!(input.bodies[0].capture_j, [26., 27., 28., 29., 30.]);
        assert_eq!(input.bodies[0].mn_owner, 6);
        assert_eq!(input.bodies[0].steel_shell_m, 35.);
        assert_eq!(input.guide_births[0].target, 8);
        assert_eq!(input.guide_births[0].share, 0.5);
    }
    #[test]
    fn every_truncation_and_trailing_field_refuses_without_panicking() {
        let mut words = frame();
        for length in 0..words.len() {
            assert!(
                read(&words[..length]).is_err(),
                "accepted truncated length {length}"
            );
        }
        words.push("0".into());
        assert!(read(&words).is_err());
    }
    #[test]
    fn nonfinite_fields_and_malformed_counts_refuse_without_panicking() {
        let words = frame();
        for value in ["NaN", "inf", "-inf", "not-a-number"] {
            let mut bad = words.clone();
            bad[0] = value.into();
            assert!(read(&bad).is_err());
        }
        for value in ["-1", "1.0", "184467440737095516160", "999999999"] {
            let mut bad = words.clone();
            bad[7] = value.into();
            assert!(read(&bad).is_err());
        }
    }
}

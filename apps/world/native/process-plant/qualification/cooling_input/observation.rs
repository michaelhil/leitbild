use super::number;
use leitbild_plant_numerics::{
    pressure_channel::Config,
    pressure_protection::{Protection, Settings},
};
pub(super) fn parse(words: &[&str]) -> Result<(Config, Settings), String> {
    if words.len() != 16 {
        return Err(
            "Required pressure-evidence frame needs six channel and ten protection fields".into(),
        );
    }
    let mut w = words.iter().copied();
    let c = Config {
        lag_s: number(&mut w),
        min_pa: number(&mut w),
        max_pa: number(&mut w),
        quantum_pa: number(&mut w),
        sample_s: number(&mut w),
        transport_s: number(&mut w),
    };
    c.validate()?;
    let s = Settings {
        maximum_age_s: number(&mut w),
        recovery_s: number(&mut w),
        high_pa: number(&mut w),
        high_qualification_s: number(&mut w),
        low_pa: number(&mut w),
        low_qualification_s: number(&mut w),
        unavailable_qualification_s: number(&mut w),
        reset_low_pa: number(&mut w),
        reset_high_pa: number(&mut w),
        reset_qualification_s: number(&mut w),
    };
    Protection::new(s)?;
    Ok((c, s))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn required_explicit_frame_has_no_default_or_extra_fields() {
        assert!(parse(&[]).is_err());
        let fields =
            "0.2 0 20000000 1000 0.1 0.1 0.3 1 15500000 0.2 13000000 0.5 1 13500000 15200000 5"
                .split_whitespace()
                .collect::<Vec<_>>();
        assert!(parse(&fields).is_ok());
        assert!(parse(&fields[..15]).is_err());
        let mut bad = fields.clone();
        bad[5] = "0.2";
        assert!(parse(&bad).is_err());
        let mut bad = fields.clone();
        bad[13] = "16000000";
        assert!(parse(&bad).is_err());
    }
}

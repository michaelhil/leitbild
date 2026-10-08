//! Strict one-time compiler frame for physical moving-control supports.
use leitbild_plant_numerics::control_source_geometry as g;
pub struct Reader<'a> {
    words: std::slice::Iter<'a, &'a str>,
}
impl<'a> Reader<'a> {
    pub fn new(words: &'a [&'a str]) -> Self {
        Self {
            words: words.iter(),
        }
    }
    fn word(&mut self) -> Result<&'a str, String> {
        self.words
            .next()
            .copied()
            .ok_or("Truncated control geometry".into())
    }
    pub fn number(&mut self) -> Result<f64, String> {
        let x = self
            .word()?
            .parse::<f64>()
            .map_err(|_| "Invalid geometry number")?;
        if !x.is_finite() {
            return Err("Nonfinite geometry number".into());
        }
        Ok(x)
    }
    pub fn count(&mut self) -> Result<usize, String> {
        self.word()?
            .parse()
            .map_err(|_| "Invalid geometry integer".into())
    }
    pub fn boolean(&mut self) -> Result<bool, String> {
        match self.count()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("Invalid geometry boolean".into()),
        }
    }
    pub fn many<T>(
        &mut self,
        mut f: impl FnMut(&mut Self) -> Result<T, String>,
    ) -> Result<Vec<T>, String> {
        let n = self.count()?;
        if n > self.words.len() {
            return Err("Geometry count exceeds remaining frame".into());
        }
        (0..n).map(|_| f(self)).collect()
    }
    pub fn end(self) -> Result<(), String> {
        if self.words.len() == 0 {
            Ok(())
        } else {
            Err("Trailing control geometry".into())
        }
    }
}
fn motion(r: &mut Reader<'_>) -> Result<g::Motion, String> {
    match r.count()? {
        0 => Ok(g::Motion::Body),
        1 => Ok(g::Motion::Stem),
        _ => Err("Invalid geometry motion".into()),
    }
}
pub fn parse(words: &[&str]) -> Result<g::Input, String> {
    let r = &mut Reader::new(words);
    let clusters = r.count()?;
    let maximum_body = r.number()?;
    let maximum_stem = r.number()?;
    let bottom = r.number()?;
    let top = r.number()?;
    let active_bottom = r.number()?;
    let active_length = r.number()?;
    let active_top = r.number()?;
    let head = r.number()?;
    let housing_top = r.number()?;
    let neck_top = r.number()?;
    let rodlets = r.number()?;
    let guide_radius = r.number()?;
    let body_radius = r.number()?;
    let guide_area = r.number()?;
    let body_area = r.number()?;
    let water = r.many(|r| {
        Ok(g::Water {
            volume: r.number()?,
            moment: r.number()?,
        })
    })?;
    let upper = r.count()?;
    let guides = r.many(|r| r.count())?;
    let passive = r.many(|r| {
        let original = r.number()?;
        let moving = if r.boolean()? {
            Some(g::Moving {
                cluster: r.count()?,
                motion: motion(r)?,
                lo: r.number()?,
                hi: r.number()?,
                spans: r.many(|r| {
                    Ok(g::Span {
                        lo: r.number()?,
                        hi: r.number()?,
                        area: r.number()?,
                    })
                })?,
            })
        } else {
            None
        };
        Ok(g::Passive { original, moving })
    })?;
    let cylinders = r.many(|r| {
        let original = r.number()?;
        let moving = r.boolean()?;
        let (cluster, lo, hi, factor) = if moving {
            (Some(r.count()?), r.number()?, r.number()?, r.number()?)
        } else {
            (None, 0., 0., 0.)
        };
        Ok(g::Cylinder {
            original,
            cluster,
            lo,
            hi,
            factor,
        })
    })?;
    let intruders = r.many(|r| {
        Ok(g::Intruder {
            cluster: r.count()?,
            motion: motion(r)?,
            lo: r.number()?,
            hi: r.number()?,
            area: r.number()?,
        })
    })?;
    let patches = r.many(|r| {
        let original = r.number()?;
        let kind = match r.count()? {
            0 => g::PatchKind::Fixed,
            1 => g::PatchKind::Upper,
            2 => g::PatchKind::Guide {
                cluster: r.count()?,
                outer: r.number()?,
                body: r.number()?,
                lo: r.number()?,
                hi: r.number()?,
            },
            3 => g::PatchKind::Housing {
                clips: r.many(|r| {
                    Ok(g::HousingClip {
                        intruder: r.count()?,
                        area: r.number()?,
                        lo: r.number()?,
                        hi: r.number()?,
                    })
                })?,
            },
            _ => return Err("Invalid current patch role".into()),
        };
        Ok(g::Patch { original, kind })
    })?;
    let row_water = r.many(|r| r.count())?;
    let routes = r.many(|r| {
        Ok(g::Route {
            patch: r.count()?,
            row: r.count()?,
            origin: r.count()?,
        })
    })?;
    let origins = r.many(|r| {
        let tag = r.count()?;
        let original_volume = r.number()?;
        let original_boundary = r.number()?;
        let kind = match tag {
            0 => g::OriginKind::Fixed,
            1 => g::OriginKind::Lower,
            2 => g::OriginKind::Upper,
            3 => g::OriginKind::Guide(r.count()?),
            4 => g::OriginKind::Housing {
                change: r.count()?,
                radius: r.number()?,
                length: r.number()?,
            },
            _ => return Err("Invalid physical origin role".into()),
        };
        let paths = r.many(|r| {
            let role = match r.count()? {
                0 => g::PathRole::Fixed(r.number()?),
                1 => g::PathRole::Side {
                    cluster: r.count()?,
                    material: match r.count()? {
                        0 => g::Material::Active,
                        1 => g::Material::Lower,
                        2 => g::Material::Upper,
                        _ => return Err("Invalid side material".into()),
                    },
                    inside: r.boolean()?,
                },
                2 => g::PathRole::End {
                    cluster: r.count()?,
                    top: r.boolean()?,
                    recipient: match r.count()? {
                        0 => g::Recipient::Lower,
                        1 => g::Recipient::Guide,
                        2 => g::Recipient::Upper,
                        _ => return Err("Invalid end recipient".into()),
                    },
                },
                _ => return Err("Invalid current photon path".into()),
            };
            let thickness = r.many(|r| r.number())?;
            Ok(g::Path { role, thickness })
        })?;
        Ok(g::Origin {
            kind,
            original_volume,
            original_boundary,
            paths,
        })
    })?;
    let contacts = r.many(|r| {
        let role = match r.count()? {
            0 => g::ContactRole::Fixed,
            1 => g::ContactRole::GuideSide,
            2 => g::ContactRole::UpperSide,
            3 => g::ContactRole::BottomLower,
            4 => g::ContactRole::BottomGuide,
            5 => g::ContactRole::TopUpper,
            _ => return Err("Invalid contact role".into()),
        };
        Ok(g::Contact {
            role,
            cluster: r.count()?,
            origin: r.count()?,
            area: r.number()?,
            solid: r.number()?,
        })
    })?;
    let barrel_paths = r.many(|r| {
        Ok(g::BarrelPath {
            origin: r.count()?,
            original_volume: r.number()?,
            original_boundary: r.number()?,
            boundary_volume_slope: r.number()?,
        })
    })?;
    if r.words.len() != 0 {
        return Err("Trailing current plan fields".into());
    }
    Ok(g::Input {
        clusters,
        maximum_body,
        maximum_stem,
        bottom,
        top,
        active_bottom,
        active_length,
        active_top,
        head,
        housing_top,
        neck_top,
        rodlets,
        guide_radius,
        body_radius,
        guide_area,
        body_area,
        water,
        upper,
        guides,
        passive,
        cylinders,
        intruders,
        patches,
        row_water,
        routes,
        origins,
        contacts,
        barrel_paths,
    })
}

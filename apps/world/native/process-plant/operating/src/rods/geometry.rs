//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#s2-moving-cell-volumes
//! Axial incidence of the moving bodies, spider and drive stem on the
//! network cells.
//!
//! Each cluster's 24 bodies occupy `[b0 + y, t0 + y]`, its spider
//! `[s0 + y, s0 + h + y]` and its drive stem `[s0 + h + y, s0 + h + L + y]`
//! (R4-ROD2-STEM: the stem falls with the cluster, as AP1000's drive rod
//! does). Above the guide top, where they displace plenum water, their area
//! follows one continuous profile ([`Profile`], E-EVT lever (b)): the
//! spider's steel over its height on a piecewise-linear profile from the
//! bodies' area through the arms/hub plane to the stem's area at its top,
//! then the stem's area to the stem top, so each plenum's displaced volume
//! is C1 in `y` wherever an end can cross a cell plane. [`Branch`] names the
//! travel direction whose side the bore paths take at a tip on the bores'
//! reference height.

/// E-EVT lever (b), plan r4, with R4-ROD2-STEM: the moving assembly's
/// displaced area along its own axis above the guide top, `a(z)` at
/// assembly-relative height `z`: the 24 bodies' area `A_b` below the spider
/// bottom `s0`, then over the spider's height `h` a continuous
/// piecewise-linear profile with nodes at `s0` (`A_b`), the arms/hub plane
/// `s0 + h/2` (the peak `P`) and the spider top `s0 + h` (the stem's `A_s`),
/// with `P` such that the spider holds exactly its steel volume `V_s` over
/// `[s0, s0 + h]`; then `A_s` over the stem's length `L`, and zero above.
/// A cell's displaced volume `G(hi - y) - G(lo - y)` (`G` the profile's
/// integral) is then C1 in `y` at every node a cell plane can meet; the
/// stem top's step lies inside HOUSING.NECK at every admitted travel (the
/// block admits travel only there), so no end crossing steps a volume rate.
#[derive(Clone, Copy, Debug)]
pub struct Profile {
    body_area: f64,
    s0: f64,
    h: f64,
    peak: f64,
    stem_area: f64,
    stem_length: f64,
}
impl Profile {
    pub fn new(
        body_area: f64,
        s0: f64,
        h: f64,
        spider_volume: f64,
        stem_area: f64,
        stem_length: f64,
    ) -> Result<Self, String> {
        // V_s = (h/2)(A_b + P)/2 + (h/2)(P + A_s)/2.
        let peak = (spider_volume - 0.25 * h * (body_area + stem_area)) / (0.5 * h);
        if !(body_area > 0.
            && h > 0.
            && peak > 0.
            && peak.is_finite()
            && stem_area > 0.
            && stem_area.is_finite()
            && stem_length > 0.
            && stem_length.is_finite())
        {
            return Err(format!(
                "rods profile: spider volume {spider_volume} m3 over {h} m cannot join the bodies' {body_area} m2 to the stem's {stem_area} m2 over {stem_length} m"
            ));
        }
        Ok(Self {
            body_area,
            s0,
            h,
            peak,
            stem_area,
            stem_length,
        })
    }
    /// The assembly-relative top of the stem, `s0 + h + L`.
    pub fn stem_top(&self) -> f64 {
        self.s0 + self.h + self.stem_length
    }
    /// `a(z)` and `a'(z)` (one-sided above at a node, as the profile's own
    /// value is continuous there; the stem top is the one step, see the
    /// type's note).
    pub fn area(&self, z: f64) -> (f64, f64) {
        let (u, half) = (z - self.s0, 0.5 * self.h);
        if u < 0. {
            (self.body_area, 0.)
        } else if u < half {
            let k = (self.peak - self.body_area) / half;
            (self.body_area + k * u, k)
        } else if u < self.h {
            let k = (self.stem_area - self.peak) / half;
            (self.peak + k * (u - half), k)
        } else if u < self.h + self.stem_length {
            (self.stem_area, 0.)
        } else {
            (0., 0.)
        }
    }
    /// `G(z) = integral of a from s0 to z` (negative below `s0`).
    pub fn integral(&self, z: f64) -> f64 {
        let (u, half) = (z - self.s0, 0.5 * self.h);
        let first = half * (self.body_area + self.peak) / 2.;
        let spider = first + half * (self.peak + self.stem_area) / 2.;
        if u < 0. {
            self.body_area * u
        } else if u < half {
            let k = (self.peak - self.body_area) / half;
            self.body_area * u + 0.5 * k * u * u
        } else if u < self.h {
            let w = u - half;
            first + self.peak * w + 0.5 * ((self.stem_area - self.peak) / half) * w * w
        } else if u < self.h + self.stem_length {
            spider + self.stem_area * (u - self.h)
        } else {
            spider + self.stem_area * self.stem_length
        }
    }
    /// Displaced volume of the span `[lo, hi]` at travel `y`, its slope and
    /// curvature in `y`.
    pub fn displaced(&self, lo: f64, hi: f64, y: f64) -> (f64, f64, f64) {
        let (a_hi, da_hi) = self.area(hi - y);
        let (a_lo, da_lo) = self.area(lo - y);
        (
            self.integral(hi - y) - self.integral(lo - y),
            a_lo - a_hi,
            da_hi - da_lo,
        )
    }
    /// The spider's own volume in the span `[lo, hi]` at travel `y` and its
    /// slope in `y`.
    pub fn spider_in(&self, lo: f64, hi: f64, y: f64) -> (f64, f64) {
        let (bottom, top) = ((lo - y).max(self.s0), (hi - y).min(self.s0 + self.h));
        if top <= bottom {
            return (0., 0.);
        }
        let d_top = if hi - y < self.s0 + self.h {
            -self.area(hi - y).0
        } else {
            0.
        };
        let d_bottom = if lo - y > self.s0 {
            -self.area(lo - y).0
        } else {
            0.
        };
        (self.integral(top) - self.integral(bottom), d_top - d_bottom)
    }
}

/// Side of a kink whose slope is taken: the travel direction's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Branch {
    /// Decreasing travel (insertion), and rest.
    Insertion,
    Withdrawal,
}
impl Branch {
    /// The branch of a current travel rate: insertion unless withdrawing.
    pub fn of_rate(rate: f64) -> Self {
        if rate > 0. {
            Self::Withdrawal
        } else {
            Self::Insertion
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_profile_is_c1_and_keeps_the_spider_and_stem_volumes() {
        let (ab, s0, h, vs) = (1.7e-3, 2.4, 0.1, 5.05e-4);
        let (a_s, l) = (std::f64::consts::PI * 0.006 * 0.006, 6.);
        let p = Profile::new(ab, s0, h, vs, a_s, l).unwrap();
        assert!((p.integral(s0 + h) - vs).abs() < 1e-18);
        assert!((p.integral(s0 + h + l) - vs - a_s * l).abs() < 1e-17);
        assert_eq!(p.area(s0 + h).0, a_s);
        // The displaced volumes of UPPER-like [2.4, 4] (from the guide
        // top), HOUSING.MAIN-like [4, 8] and HOUSING.NECK-like [8.05, 13.6]:
        // with the cap bore [8, 8.05] (the stem's constant area) their sum is
        // the spider, the stem and the bodies above the guide top, and the
        // slopes are continuous at the end crossings y = 1.6, 1.55 and 1.5.
        let spans = [(2.4, 4.), (4., 8.), (8.05, 13.6)];
        for y in [0., 1.5, 1.55, 1.6, 2.0, 0.7, 3.4839, 4.] {
            let d: Vec<_> = spans
                .iter()
                .map(|(lo, hi)| p.displaced(*lo, *hi, y))
                .collect();
            let total: f64 = d.iter().map(|x| x.0).sum();
            let slope: f64 = d.iter().map(|x| x.1).sum();
            assert!(
                (total + a_s * 0.05 - (vs + a_s * l + ab * y)).abs() < 1e-15,
                "{y}"
            );
            assert!((slope - ab).abs() < 1e-15, "{y}");
            // The neck holds the stem's top: its slope is the stem's area.
            assert!((d[2].1 - a_s).abs() < 1e-18, "{y}");
            for (k, (lo, hi)) in spans.iter().enumerate() {
                let e = p.displaced(*lo, *hi, y + 1e-6).0;
                assert!(((e - d[k].0) / 1e-6 - d[k].1).abs() < 1e-7, "{y} {k}");
                for dy in [-1e-9, 1e-9] {
                    assert!(
                        (p.displaced(*lo, *hi, y + dy).1 - d[k].1).abs() < 1e-8,
                        "{y} {k} {dy}"
                    );
                }
            }
        }
        let (a, b) = (p.spider_in(2.4, 4., 1.55).0, p.spider_in(4., 8., 1.55).0);
        assert!((a + b - vs).abs() < 1e-18);
        assert!(Profile::new(ab, s0, h, 1e-6, a_s, l).is_err());
        assert!(Profile::new(ab, s0, h, vs, 0., l).is_err());
    }
}

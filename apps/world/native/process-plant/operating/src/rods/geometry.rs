//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#s2-moving-cell-volumes
//! Axial incidence of the moving spider and bodies on the network cells.
//!
//! Each cluster's 24 bodies occupy `[b0 + y, t0 + y]` and its spider
//! `[s0 + y, s0 + h + y]`. Above the guide top, where the bodies and spider
//! displace plenum water, their area follows one continuous profile
//! ([`Profile`], E-EVT lever (b)): the spider's steel over its height on a
//! piecewise-linear profile from the bodies' area through the arms/hub plane
//! to zero at its top, so each plenum's displaced volume is C1 in `y`.
//! [`Branch`] names the travel direction whose side the bore paths take
//! at a tip on the bores' reference height.

/// E-EVT lever (b), plan r4: the moving assembly's displaced area along its
/// own axis above the guide top, `a(z)` at assembly-relative height `z`: the
/// 24 bodies' area `A_b` below the spider bottom `s0`, then over the spider's
/// height `h` a continuous piecewise-linear profile with nodes at `s0`
/// (`A_b`), the arms/hub plane `s0 + h/2` (the peak `P`) and the spider top
/// `s0 + h` (zero), with `P` such that the spider holds exactly its steel
/// volume `V_s` over `[s0, s0 + h]`. A cell's displaced volume
/// `G(hi - y) - G(lo - y)` (`G` the profile's integral) is then C1 in `y`,
/// so no end crossing a cell plane steps a cell's volume rate.
#[derive(Clone, Copy, Debug)]
pub struct Profile {
    body_area: f64,
    s0: f64,
    h: f64,
    peak: f64,
}
impl Profile {
    pub fn new(body_area: f64, s0: f64, h: f64, spider_volume: f64) -> Result<Self, String> {
        // V_s = (h/2)(A_b + P)/2 + (h/2) P/2.
        let peak = (spider_volume - 0.25 * h * body_area) / (0.5 * h);
        if !(body_area > 0. && h > 0. && peak > 0. && peak.is_finite()) {
            return Err(format!(
                "rods profile: spider volume {spider_volume} m3 over {h} m cannot meet the bodies' {body_area} m2"
            ));
        }
        Ok(Self {
            body_area,
            s0,
            h,
            peak,
        })
    }
    /// `a(z)` and `a'(z)` (one-sided above at a node, as the profile's own
    /// value is continuous there).
    pub fn area(&self, z: f64) -> (f64, f64) {
        let (u, half) = (z - self.s0, 0.5 * self.h);
        if u < 0. {
            (self.body_area, 0.)
        } else if u < half {
            let k = (self.peak - self.body_area) / half;
            (self.body_area + k * u, k)
        } else if u < self.h {
            let k = -self.peak / half;
            (self.peak + k * (u - half), k)
        } else {
            (0., 0.)
        }
    }
    /// `G(z) = integral of a from s0 to z` (negative below `s0`).
    pub fn integral(&self, z: f64) -> f64 {
        let (u, half) = (z - self.s0, 0.5 * self.h);
        let first = half * (self.body_area + self.peak) / 2.;
        if u < 0. {
            self.body_area * u
        } else if u < half {
            let k = (self.peak - self.body_area) / half;
            self.body_area * u + 0.5 * k * u * u
        } else if u < self.h {
            let w = u - half;
            first + self.peak * w - 0.5 * (self.peak / half) * w * w
        } else {
            first + 0.5 * self.peak * half
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
        let d_top = if hi - y < self.s0 + self.h { -self.area(hi - y).0 } else { 0. };
        let d_bottom = if lo - y > self.s0 { -self.area(lo - y).0 } else { 0. };
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
    fn the_profile_is_c1_and_keeps_the_spider_volume() {
        let (ab, s0, h, vs) = (1.7e-3, 2.4, 0.1, 5.05e-4);
        let p = Profile::new(ab, s0, h, vs).unwrap();
        assert!((p.integral(s0 + h) - vs).abs() < 1e-18);
        // The displaced volume of HOUSING.MAIN-like [4, 8] and UPPER-like
        // [2.4, 4] (from the guide top): their sum is the spider and the
        // bodies above the guide top, and the slope is continuous at the end
        // crossings y = 1.6, 1.55 and 1.5.
        for y in [1.5, 1.55, 1.6, 2.0, 0.7] {
            let (d1, k1, _) = p.displaced(4., 8., y);
            let (d0, k0, _) = p.displaced(2.4, 4., y);
            let (e1, _, _) = p.displaced(4., 8., y + 1e-6);
            assert!((k1 + k0 - ab).abs() < 1e-15, "{y}");
            assert!(((e1 - d1) / 1e-6 - k1).abs() < 1e-7, "{y}");
            for dy in [-1e-9, 1e-9] {
                assert!((p.displaced(4., 8., y + dy).1 - k1).abs() < 1e-8, "{y} {dy}");
            }
            assert!((d1 + d0 - (vs + ab * y)).abs() < 1e-15, "{y}");
        }
        let (a, b) = (p.spider_in(2.4, 4., 1.55).0, p.spider_in(4., 8., 1.55).0);
        assert!((a + b - vs).abs() < 1e-18);
        assert!(Profile::new(ab, s0, h, 1e-6).is_err());
    }
}

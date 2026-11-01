//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! The SG tube heat path of one developed-length metal segment, by the
//! existing laws: the primary tube film from the SG primary cell into the
//! metal and the secondary wet/gas contact from the metal into the water.
//! In the joined spine the solids own the metal and both films; this is the
//! same composition as a tested function for zero-time receipts and
//! isolated probes, plus the stationary local wall balance of one segment.
//! It adds no law, fit, cache or held state.
use super::packet;
use crate::{
    joined::block::SecondaryView,
    network::Failure,
    thermal::{self, Film, Saturation, Scalar, WallLaw, WallMaterial, WaterPoint, WaterProperties},
};
use serde::Serialize;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}

/// The SG primary cell at the current trial, with the exact saturation and
/// bulk tuples of the same call (same-call reuse, not a cache).
#[derive(Clone, Copy, Debug)]
pub struct PrimaryPort {
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub saturation: Saturation,
    pub bulk: WaterPoint,
    /// Wall mass flux `sum(w m_face)/A_flow`, kg/(m² s).
    pub mass_flux: Scalar,
    /// X4.5 (lead ruling d): the inflow's temperature and capacity rate
    /// (W/K), the single-pass law's inlet.
    pub inflow_temperature: Scalar,
    pub inflow_capacity_w_k: Scalar,
}

impl PrimaryPort {
    /// A held liquid primary state with its own maintained tuples: the cell
    /// at `temperature_k`, fed at `inlet_k` with `mass_flow_kg_s` over the
    /// tube film's `flow_area_m2`. The inflow's capacity rate takes the mean
    /// of the inflow's and the cell's specific heat (the joined solids' rule).
    pub fn held<P: WaterProperties>(
        props: &P,
        pressure_pa: f64,
        temperature_k: f64,
        inlet_k: f64,
        mass_flow_kg_s: f64,
        flow_area_m2: f64,
    ) -> Result<Self, Failure> {
        let (p, t) = (s(pressure_pa), s(temperature_k));
        let bulk = props
            .liquid(p, t)
            .map_err(|e| fatal(format!("primary liquid: {e}")))?;
        let inflow = props
            .liquid(p, s(inlet_k))
            .map_err(|e| fatal(format!("primary inflow liquid: {e}")))?;
        Ok(Self {
            pressure: p,
            temperature: t,
            saturation: props
                .saturation(p)
                .map_err(|e| fatal(format!("primary saturation: {e}")))?,
            bulk,
            mass_flux: s(mass_flow_kg_s / flow_area_m2),
            inflow_temperature: s(inlet_k),
            inflow_capacity_w_k: s(mass_flow_kg_s.abs()) * s(0.5) * (inflow.cp + bulk.cp),
        })
    }
}

/// One developed-length metal segment.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Segment {
    pub start_m: f64,
    pub end_m: f64,
    pub area_m2: f64,
    pub capacity_j_k: f64,
}

impl From<&packet::Segment> for Segment {
    fn from(g: &packet::Segment) -> Self {
        Self {
            start_m: g.developed_start_m,
            end_m: g.developed_end_m,
            area_m2: g.exchange_area_m2,
            capacity_j_k: g.capacity_j_k,
        }
    }
}

/// The two films' wall law constants: the tube film for the primary side;
/// the thermal diameter also for the secondary contact.
#[derive(Clone, Copy, Debug)]
pub struct Tube {
    law: WallLaw,
    /// X4.5 (`ld01-sg-contact`): primary over outer area `ID/OD`, the outside
    /// diameter of the secondary contact, and the wall plus fouling
    /// resistance per primary area in series with the primary film.
    inner_fraction: f64,
    outside_diameter_m: f64,
    series_m2k_w: f64,
    /// The SG's whole outer exchange area (the segments' share base).
    exchange_area_m2: f64,
    /// The tube wetting's two-zone contact coordinate (S3-D26).
    contact_map: thermal::ContactMap,
}

/// The stationary local wall balance of one segment at a held primary and
/// secondary: the metal temperature at which primary-to-metal heat equals
/// metal-to-secondary heat.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Stationary {
    pub wall_k: f64,
    pub primary_to_metal_w: f64,
    pub metal_to_secondary_w: f64,
    pub primary_mode: &'static str,
    /// The secondary wet law's branch at full wetting (a diagnostic of the
    /// same law; the heat is `metal_to_secondary_w`).
    pub secondary_wet_mode: &'static str,
    /// d(primary - secondary)/dT_wall at the root, W/K.
    pub slope_w_k: f64,
    pub iterations: usize,
}

impl Tube {
    /// The tube film's law from the contact block's wall constants and the
    /// effective thermal diameter.
    pub fn new(
        c: &packet::Contact,
        thermal_diameter_m: f64,
        exposure: &packet::Exposure,
    ) -> Result<Self, Failure> {
        let contact_map = exposure.contact_map().map_err(fatal)?;
        c.check(exposure.fold.developed_length_m).map_err(fatal)?;
        if thermal_diameter_m.to_bits() != c.tube_inside_diameter_m.to_bits() {
            return Err(fatal(
                "SG tube thermal diameter is not the bundle's inside diameter",
            ));
        }
        if ![
            thermal_diameter_m,
            c.exchange_area_m2,
            c.steel_conductivity_w_mk,
            c.steel_density_kg_m3,
            c.steel_cp_j_kgk,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
            || !(c.emissivity > 0. && c.emissivity <= 1.)
        {
            return Err(fatal("SG tube law constants"));
        }
        Ok(Self {
            contact_map,
            inner_fraction: c.inner_fraction(),
            outside_diameter_m: c.tube_outside_diameter_m,
            series_m2k_w: c.primary_series_m2k_w(),
            exchange_area_m2: c.exchange_area_m2,
            law: WallLaw {
                diameter_m: thermal_diameter_m,
                film: Film::Tube,
                emissivity: c.emissivity,
                material: WallMaterial {
                    conductivity: s(c.steel_conductivity_w_mk),
                    density: c.steel_density_kg_m3,
                    cp: s(c.steel_cp_j_kgk),
                },
            },
        })
    }

    pub fn law(&self) -> WallLaw {
        self.law
    }

    /// Heat from the primary cell into the segment's metal and from the metal
    /// into the secondary, both W, at metal temperature `wall_k`.
    pub fn segment_heat<P: WaterProperties>(
        &self,
        props: &P,
        port: &PrimaryPort,
        view: &SecondaryView,
        wall_k: Scalar,
        segment: &Segment,
    ) -> Result<(Scalar, Scalar), Failure> {
        // X4.5 (lead ruling d): the exact single-pass law of the one mixed
        // cell, the segment carrying its area share of the whole fold's.
        let u = thermal::tube_series_conductance(
            props,
            port.pressure,
            port.temperature,
            wall_k,
            port.mass_flux,
            self.law,
            port.saturation,
            port.bulk,
            self.series_m2k_w,
        )
        .map_err(|e| recoverable(format!("SG tube primary film: {e}")))?;
        let whole = thermal::single_pass_heat(
            u * s(self.exchange_area_m2 * self.inner_fraction),
            port.inflow_capacity_w_k,
            port.inflow_temperature,
            wall_k,
        )
        .map_err(|e| recoverable(format!("SG tube single pass: {e}")))?;
        let secondary = thermal::secondary_wall(
            props,
            view.pressure,
            view.saturation_temperature,
            wall_k,
            view.liquid_volume,
            segment.start_m,
            segment.end_m,
            segment.area_m2,
            self.outside_diameter_m,
            thermal::SteelContact {
                emissivity: self.law.emissivity,
                material: self.law.material,
            },
            view.steam_present,
            self.contact_map,
        )
        .map_err(|e| recoverable(format!("SG tube secondary contact: {e}")))?;
        Ok((
            whole * s(segment.area_m2 / self.exchange_area_m2),
            secondary,
        ))
    }

    /// Solve the stationary local wall balance of one segment by safeguarded
    /// Newton on the exact wall direction, bracketed between the secondary
    /// saturation and the primary temperature. Requires a primary hotter than
    /// the secondary saturation; stops at `|q_p - q_s| <= 1e-12 |q_s|` or a
    /// bracket narrower than one ulp.
    pub fn stationary<P: WaterProperties>(
        &self,
        props: &P,
        port: &PrimaryPort,
        view: &SecondaryView,
        segment: &Segment,
    ) -> Result<Stationary, Failure> {
        let (mut lo, mut hi) = (
            view.saturation_temperature.value,
            port.temperature.value.max(port.inflow_temperature.value),
        );
        if lo.is_nan() || hi.is_nan() || lo >= hi {
            return Err(fatal(
                "stationary wall needs a primary hotter than secondary saturation",
            ));
        }
        let fixed = |v: &SecondaryView| SecondaryView {
            pressure: s(v.pressure.value),
            saturation_temperature: s(v.saturation_temperature.value),
            liquid_volume: s(v.liquid_volume.value),
            steam_present: v.steam_present,
        };
        let view = fixed(view);
        let balance = |tw: f64| -> Result<(f64, f64, f64), Failure> {
            let (qp, qs) = self.segment_heat(props, port, &view, Scalar::new(tw, 1.), segment)?;
            Ok((qp.value - qs.value, qp.direction - qs.direction, qs.value))
        };
        let mut tw = 0.5 * (lo + hi);
        for iteration in 1..=200 {
            let (f, df, qs) = balance(tw)?;
            if f > 0. {
                lo = tw;
            } else {
                hi = tw;
            }
            let converged = f.abs() <= 1e-12 * qs.abs() || hi.next_down() <= lo;
            if converged {
                let (qp, qs) = self.segment_heat(props, port, &view, s(tw), segment)?;
                let primary = thermal::liquid_wall_current(
                    props,
                    port.pressure,
                    port.temperature,
                    s(tw),
                    port.mass_flux,
                    self.law,
                    port.saturation,
                    port.bulk,
                )
                .map_err(|e| recoverable(e.to_string()))?;
                let secondary = thermal::liquid_wall(
                    props,
                    view.pressure,
                    view.saturation_temperature,
                    s(tw),
                    s(0.),
                    WallLaw {
                        film: Film::External,
                        diameter_m: self.outside_diameter_m,
                        ..self.law
                    },
                )
                .map_err(|e| recoverable(e.to_string()))?;
                return Ok(Stationary {
                    wall_k: tw,
                    primary_to_metal_w: qp.value,
                    metal_to_secondary_w: qs.value,
                    primary_mode: primary.mode,
                    secondary_wet_mode: secondary.mode,
                    slope_w_k: df,
                    iterations: iteration,
                });
            }
            let newton = tw - f / df;
            tw = if df < 0. && newton > lo && newton < hi {
                newton
            } else {
                0.5 * (lo + hi)
            };
        }
        Err(fatal(
            "stationary wall balance did not converge in 200 iterations",
        ))
    }
}

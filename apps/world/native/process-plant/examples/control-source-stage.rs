//! One retained SOURCE and finite-recipient model evaluated on coherent current
//! geometry. This is a stage/derivative qualification, NOT an advancing plant.
//! Even externally attained poses are applied to unchanged SOURCE history and
//! fresh diagnostic M=rho*V snapshots; no advection or coupled motion is claimed.
#![allow(dead_code)]
#[path = "../qualification/cooling_input/absorber_guide.rs"]
mod absorber_input;
#[path = "../qualification/evolution_input/mod.rs"]
mod evolution_input;
#[path = "../qualification/cooling_input/mobile.rs"]
mod mobile_input;
#[path = "../qualification/source_geometry.rs"]
mod source_geometry;
#[path = "../qualification/source_input/mod.rs"]
mod source_input;
use leitbild_plant_numerics::{
    absorber_guide as ag, barrel_thermal as bt, converter_heat, cylindrical_source, fuel_history,
    fuel_source, heat_history, liquid_batch, mobile_capture as mc, moderator_source as ms,
    optical_source, passive_source, source_evolution as se, transport_source, Liquid, LiquidQuery,
};
use ms as moderator_source;
use se as source_evolution;
use source_input::{count, framed, number, Words};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::Path,
    time::Instant,
};

fn array(w: &mut Words<'_>) -> Vec<f64> {
    let n = count(w);
    assert!(n <= w.len(), "Array exceeds frame");
    (0..n).map(|_| number(w)).collect()
}
fn contacts(w: &mut Words<'_>) -> Vec<ag::ContactGeometry> {
    let n = count(w);
    assert!(n <= w.len() / 3, "Contact count exceeds frame");
    (0..n)
        .map(|_| ag::ContactGeometry {
            area_m2: number(w),
            solid_geometry_m_inv: number(w),
            liquid_chord_m: number(w),
        })
        .collect()
}
#[derive(Clone)]
struct Part {
    source: se::Geometry,
    contacts: Vec<ag::ContactGeometry>,
    mobile: mc::Geometry,
    water: Vec<[f64; 2]>,
}
fn part(w: &mut Words<'_>) -> Part {
    let mut source = se::Geometry {
        passive_volumes: array(w),
        cylinder_shares: array(w),
        moderator_volumes: array(w),
        external_water_volumes: Vec::new(),
    };
    let contacts = contacts(w);
    let mobile = mc::Geometry {
        birth_shares: array(w),
        liquid_chords_m: array(w),
        path_shares: array(w),
        wall_thicknesses_m: array(w),
        boundary_shares: array(w),
    };
    let n = count(w);
    assert!(n <= w.len() / 2, "Water count exceeds frame");
    let water = (0..n).map(|_| [number(w), number(w)]).collect::<Vec<_>>();
    // The finite physical owner V/J is serialized once. Bulk volume is not
    // liquid occupation: a later partially wet owner may contain vapor too.
    source.external_water_volumes = water.iter().map(|v| v[0]).collect();
    Part {
        source,
        contacts,
        mobile,
        water,
    }
}
struct Stage {
    value: Part,
    direction: Part,
}
fn stage(w: &mut Words<'_>) -> Stage {
    Stage {
        value: part(w),
        direction: part(w),
    }
}
struct Cell {
    volume: f64,
    moment: f64,
    temperature: f64,
    marker: f64,
}
struct Model {
    source: se::Evolution,
    operators: source_geometry::Verifier,
    absorber: ag::Model,
    mobile: mc::Model,
    jacobian: se::Jacobian,
    closed_volumes: Vec<f64>,
    cells: Vec<Cell>,
    density: f64,
    saturation: f64,
    href: f64,
    bref: f64,
    pressure: f64,
    temperature: f64,
    datum: f64,
}
impl Model {
    fn prepare(
        source_text: &str,
        metadata: &[&str],
        absorber: &[&str],
        mobile: &[&str],
    ) -> Result<Self, String> {
        let mut input = evolution_input::parse(source_text).input;
        let mut w = metadata.iter().copied();
        let pressure = number(&mut w);
        let temperature = number(&mut w);
        let datum = number(&mut w);
        let href = number(&mut w);
        let bref = number(&mut w);
        if pressure <= 0. || temperature <= 0. || href <= 0. || bref < 0. {
            return Err("Invalid physical carrier preparation".into());
        }
        let n = count(&mut w);
        assert!(n <= w.len(), "Closed count exceeds metadata");
        let closed = (0..n).map(|_| count(&mut w)).collect::<Vec<_>>();
        if closed.iter().any(|&i| i >= input.water_owners.len())
            || closed.iter().copied().collect::<BTreeSet<_>>().len() != closed.len()
        {
            return Err("Invalid closed receiving owner indices".into());
        }
        let n = count(&mut w);
        assert!(n <= w.len() / 4, "Water count exceeds metadata");
        let cells = (0..n)
            .map(|_| Cell {
                volume: number(&mut w),
                moment: number(&mut w),
                temperature: number(&mut w),
                marker: number(&mut w),
            })
            .collect::<Vec<_>>();
        if cells.iter().any(|c| c.volume <= 0.) {
            return Err("Nonpositive finite water volume".into());
        }
        let mut liquid = [Liquid::default()];
        liquid_batch(
            &[LiquidQuery {
                pressure,
                temperature,
            }],
            &mut liquid,
        )
        .map_err(|e| e.message)?;
        let density = liquid[0].density;
        let saturation = leitbild_plant_numerics::sg_secondary::cold_saturation_temperature(
            temperature,
            pressure,
        )?;
        let n = count(&mut w);
        assert!(n <= w.len() / 3, "Passive count exceeds metadata");
        input.passive_incidence = (0..n)
            .map(|_| passive_source::Intersection {
                stock: count(&mut w),
                region: count(&mut w),
                volume: number(&mut w),
            })
            .collect();
        let n = count(&mut w);
        assert!(n <= w.len() / 3, "Cylinder count exceeds metadata");
        input.cylinder_incidence = (0..n)
            .map(|_| cylindrical_source::Intersection {
                target: count(&mut w),
                region: count(&mut w),
                share: number(&mut w),
            })
            .collect();
        let old_rows = input.moderator.intersections();
        let mut owners = closed
            .iter()
            .map(|&i| input.water_owners[i])
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut mapping = Vec::new();
        let mut stocks = Vec::new();
        for (i, m) in input.row_map.iter().enumerate() {
            if let Some(owner) = closed.iter().position(|&o| o == m.owner) {
                rows.push(old_rows[i]);
                stocks.push(input.water_rows[i]);
                mapping.push(se::WaterRow { owner, ..*m });
            }
        }
        let closed_volumes = rows.iter().map(|r| r.volume).collect::<Vec<_>>();
        for (i, c) in cells.iter().enumerate() {
            let mass = density * c.volume;
            owners.push(se::WaterOwner {
                authority: se::WaterAuthority::External { index: i },
                hydrogen: href * mass,
                hydrogen_product: 0.,
                boron: bref * mass,
                boron_product: 0.,
            });
        }
        let n = count(&mut w);
        assert!(n <= w.len() / 3, "Primary count exceeds metadata");
        let mut seen = BTreeSet::new();
        for _ in 0..n {
            let region = count(&mut w);
            let cell = count(&mut w);
            let volume = number(&mut w);
            if cell >= cells.len() || !seen.insert((region, cell)) || volume < 0. {
                return Err("Invalid primary union incidence".into());
            }
            let mass = density * volume;
            rows.push(ms::Intersection { region, volume });
            mapping.push(se::WaterRow {
                owner: closed.len() + cell,
                h_fraction: 0.,
                b_fraction: 0.,
            });
            stocks.push(ms::Stocks {
                water_mass: mass,
                liquid_volume: volume,
                hydrogen_target: href * mass,
                hydrogen_product: 0.,
                mobile_boron10: bref * mass,
            });
        }
        let clad = mc::CladRecipients {
            node_count: count(&mut w),
            rows: {
                let n = count(&mut w);
                assert!(n <= w.len());
                (0..n).map(|_| count(&mut w)).collect()
            },
        };
        if w.next().is_some() {
            return Err("Trailing current source metadata".into());
        }
        input.moderator = ms::ModeratorModel::new(
            input.moderator.law().clone(),
            input.moderator.volumes().to_vec(),
            rows,
        )?;
        input.water_owners = owners;
        input.external_water_volumes = cells.iter().map(|c| c.volume).collect();
        input.water_rows = stocks;
        input.row_map = mapping;
        // Independent component operators are prepared once from the exact
        // same physical input, before its owned histories enter Evolution.
        let operators = source_geometry::Verifier::new(&input)?;
        let source = se::Evolution::new(input)?;
        let absorber = ag::Model::new(&source, cells.len(), absorber_input::parse(absorber)?)?;
        let mobile = mc::Model::new(
            &source,
            clad,
            cells.len(),
            absorber.host_count(),
            mobile_input::parse(mobile)?,
        )?;
        let jacobian = se::Jacobian::new(&source)?;
        Ok(Self {
            source,
            operators,
            absorber,
            mobile,
            jacobian,
            closed_volumes,
            cells,
            density,
            saturation,
            href,
            bref,
            pressure,
            temperature,
            datum,
        })
    }
    fn geometry(&self, g: &se::Geometry, direction: bool) -> se::Geometry {
        let mut out = g.clone();
        out.moderator_volumes = if direction {
            vec![0.; self.closed_volumes.len()]
        } else {
            self.closed_volumes.clone()
        };
        out.moderator_volumes.extend(&g.moderator_volumes);
        out
    }
    fn water(&self, part: &Part) -> Result<Vec<ms::Stocks>, String> {
        if part.water.len() != self.cells.len() {
            return Err("Current finite water shape differs".into());
        }
        Ok(part
            .water
            .iter()
            .map(|v| {
                let mass = self.density * v[0];
                // A nonzero conserved-product fraction exercises the owner-ratio
                // derivative. These diagnostic stocks are NOT advected states.
                let product = 1e-6 * self.href * mass;
                ms::Stocks {
                    water_mass: mass,
                    liquid_volume: v[0],
                    hydrogen_target: self.href * mass - product,
                    hydrogen_product: product,
                    mobile_boron10: self.bref * mass,
                }
            })
            .collect())
    }
}
fn ag_fields(v: &ag::Delivery) -> Vec<f64> {
    v.host
        .iter()
        .chain(&v.water)
        .chain(&v.nuclear_host)
        .chain(&v.nuclear_water)
        .copied()
        .chain([v.exported, v.emitted])
        .chain(v.family_emitted)
        .collect()
}
fn mobile_fields(v: &mc::Delivery) -> Vec<f64> {
    v.recipient_power()
        .chain(v.channels.iter().copied())
        .chain([v.exported, v.boundary_exported])
        .collect()
}
fn receipt(terms: impl IntoIterator<Item = f64>, name: &str) -> Result<(f64, f64), String> {
    let (mut sum, mut scale) = (0., 0.);
    for x in terms {
        sum += x;
        scale += x.abs();
    }
    let bound = 1e-12 + 1024. * f64::EPSILON * scale;
    if !sum.is_finite() || sum.abs() > bound {
        return Err(format!("{name} defect {sum:e}, arithmetic bound {bound:e}"));
    }
    Ok((sum, bound))
}
#[derive(Default, Clone)]
struct Error {
    ratio: f64,
    absolute: f64,
    index: usize,
    a: f64,
    b: f64,
}
impl Error {
    fn add(&mut self, i: usize, a: f64, b: f64, atol: f64, rtol: f64) -> Result<(), String> {
        if !a.is_finite() || !b.is_finite() {
            return Err("Nonfinite comparison".into());
        }
        let absolute = (a - b).abs();
        let ratio = absolute / (atol + rtol * a.abs().max(b.abs()));
        if ratio > self.ratio {
            *self = Self {
                ratio,
                absolute,
                index: i,
                a,
                b,
            };
        }
        Ok(())
    }
    fn json(&self) -> String {
        format!(
            "{{\"ratio\":{},\"absolute\":{},\"index\":{},\"analytic\":{},\"reference\":{}}}",
            self.ratio, self.absolute, self.index, self.a, self.b
        )
    }
}
// Output quantization is a *minimum* finite-difference resolution, not a
// rigorous bound on all arithmetic inside the evaluated model. Keep it separate
// from the unchanged accuracy criterion and never count an unresolved field as
// a qualified derivative.
#[derive(Default)]
struct FiniteDifference {
    checked: usize,
    resolved: usize,
    resolution_limited: usize,
    gross_mismatches: usize,
    raw: Error,
    resolved_error: Error,
    resolution_ratio: f64,
    resolution: f64,
    accuracy: f64,
    index: usize,
    analytic: f64,
    reference: f64,
}
fn ulp(value: f64) -> f64 {
    let value = value.abs();
    value.next_up() - value
}
impl FiniteDifference {
    fn add(
        &mut self,
        i: usize,
        analytic: f64,
        plus: f64,
        minus: f64,
        epsilon: f64,
        atol: f64,
        rtol: f64,
    ) -> Result<(), String> {
        if !plus.is_finite() || !minus.is_finite() {
            return Err("Nonfinite finite-difference value".into());
        }
        let reference = (plus - minus) / (2. * epsilon);
        self.raw.add(i, analytic, reference, atol, rtol)?;
        let accuracy = atol + rtol * analytic.abs().max(reference.abs());
        let resolution = (ulp(plus) + ulp(minus)) / (4. * epsilon);
        self.checked += 1;
        if resolution <= accuracy {
            self.resolved += 1;
            self.resolved_error
                .add(i, analytic, reference, atol, rtol)?;
        } else {
            self.resolution_limited += 1;
            let ratio = resolution / accuracy;
            if ratio > self.resolution_ratio {
                self.resolution_ratio = ratio;
                self.resolution = resolution;
                self.accuracy = accuracy;
                self.index = i;
                self.analytic = analytic;
                self.reference = reference;
            }
            // A limited field is inconclusive at the requested precision. It
            // still cannot excuse an unmistakable wrong zero or opposite sign.
            let signal = resolution + accuracy;
            let opposite = analytic.signum() != reference.signum()
                && analytic.abs() > signal
                && reference.abs() > signal;
            let wrong_zero = (analytic == 0. && reference.abs() > signal)
                || (reference == 0. && analytic.abs() > signal);
            self.gross_mismatches += usize::from(opposite || wrong_zero);
        }
        Ok(())
    }
    fn pass(&self) -> bool {
        self.resolved_error.ratio <= 1. && self.gross_mismatches == 0
    }
    fn json(&self) -> String {
        let coverage = if self.resolution_limited == 0 {
            "full"
        } else {
            "partial"
        };
        format!(
            "{{\"pass\":{},\"coverage\":\"{coverage}\",\"checked\":{},\"resolved\":{},\"resolution_limited\":{},\"gross_mismatches\":{},\"raw_worst\":{},\"resolved_worst\":{},\"minimum_output_resolution_worst\":{{\"ratio_to_accuracy\":{},\"resolution\":{},\"accuracy\":{},\"index\":{},\"analytic\":{},\"reference\":{}}}}}",
            self.pass(),
            self.checked,
            self.resolved,
            self.resolution_limited,
            self.gross_mismatches,
            self.raw.json(),
            self.resolved_error.json(),
            self.resolution_ratio,
            self.resolution,
            self.accuracy,
            self.index,
            self.analytic,
            self.reference
        )
    }
}

// This qualification compares physical coefficients before multiplying by a
// huge neutron population. The units and accuracy are frozen independently of
// the observed aggregate RHS cancellation. Neither test changes runtime laws.
struct OperatorCheck {
    groups: Vec<(source_geometry::Group, usize, Error)>,
}
impl OperatorCheck {
    fn new(
        base: &source_geometry::Stage,
        plus: &source_geometry::Stage,
        minus: &source_geometry::Stage,
        epsilon: f64,
    ) -> Result<Self, String> {
        let n = base.coefficients.len();
        if base.direction.len() != n
            || plus.coefficients.len() != n
            || minus.coefficients.len() != n
        {
            return Err("Operator finite-difference dimensions differ".into());
        }
        let mut end = 0;
        let mut groups = Vec::new();
        for g in &base.groups {
            if g.start != end || g.end < g.start || g.end > n {
                return Err("Operator group partition differs".into());
            }
            let mut error = Error::default();
            let mut nonzero = 0;
            for i in g.start..g.end {
                let a = base.direction[i];
                let b = (plus.coefficients[i] - minus.coefficients[i]) / (2. * epsilon);
                error.add(i, a, b, 1e-10, 1e-5)?;
                nonzero += usize::from(a != 0.);
            }
            groups.push((
                source_geometry::Group {
                    name: g.name,
                    units: g.units,
                    start: g.start,
                    end: g.end,
                },
                nonzero,
                error,
            ));
            end = g.end;
        }
        if end != n {
            return Err("Operator groups do not cover every coefficient".into());
        }
        Ok(Self { groups })
    }
    fn pass(&self) -> bool {
        self.groups.iter().all(|(_, _, e)| e.ratio <= 1.)
    }
    fn json(&self) -> String {
        let groups=self.groups.iter().map(|(g,n,e)|format!(
            "{{\"name\":\"{}\",\"units\":\"{}\",\"start\":{},\"end\":{},\"checked\":{},\"nonzero_directions\":{},\"error\":{}}}",
            g.name,g.units,g.start,g.end,g.end-g.start,n,e.json())).collect::<Vec<_>>().join(",");
        format!("{{\"pass\":{},\"coverage\":\"all declared current-geometry operators\",\"absolute_tolerance_in_each_declared_unit\":1e-10,\"relative_tolerance\":1e-5,\"physical_accuracy_claim\":false,\"groups\":[{groups}]}}",self.pass())
    }
}

fn negative_control(values: &[f64], energy: impl Fn(usize) -> bool) -> Result<String, String> {
    let (index, &signal) = values
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .ok_or("Empty negative-control direction")?;
    let atol = if energy(index) { 1e-6 } else { 1e-3 };
    negative_control_at(index, signal, atol)
}
fn negative_control_at(index: usize, signal: f64, atol: f64) -> Result<String, String> {
    let mut omitted = Error::default();
    let mut reversed = Error::default();
    omitted.add(index, 0., signal, atol, 1e-5)?;
    reversed.add(index, -signal, signal, atol, 1e-5)?;
    if omitted.ratio <= 1. || reversed.ratio <= 1. {
        return Err("Negative control has no signal above declared comparison accuracy".into());
    }
    Ok(format!("{{\"index\":{index},\"actual_signal\":{signal},\"omitted_rejected\":true,\"reversed_rejected\":true,\"omitted_error\":{},\"reversed_error\":{}}}",omitted.json(),reversed.json()))
}
struct ResultStage {
    source: Vec<f64>,
    dsource: Vec<f64>,
    absorber: Vec<f64>,
    dabsorber: Vec<f64>,
    mobile: Vec<f64>,
    dmobile: Vec<f64>,
    dexternal: Vec<f64>,
    receipts: Vec<f64>,
    operators: source_geometry::Stage,
    assembly_source: Error,
    assembly_external: Error,
    nc: Error,
    csc: Error,
    elapsed: [f64; 6],
    captures: f64,
    neutron_ledger: f64,
}
fn check_deadline(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        Err("Native stage execution budget reached".into())
    } else {
        Ok(())
    }
}
fn evaluate(
    m: &mut Model,
    s: &Stage,
    y: &[f64],
    sw: &mut se::Workspace,
    aw: &mut ag::Workspace,
    mw: &mut mc::Workspace,
    deadline: Instant,
) -> Result<ResultStage, String> {
    check_deadline(deadline)?;
    let g = m.geometry(&s.value.source, false);
    let dg = m.geometry(&s.direction.source, true);
    let water = m.water(&s.value)?;
    let dwater = m.water(&s.direction)?;
    let temperatures = m.source.prepared_temperatures();
    let host_t = (0..m.absorber.host_count())
        .map(|i| 300. + 0.01 * (i % 11) as f64)
        .collect::<Vec<_>>();
    let wet = m
        .cells
        .iter()
        .enumerate()
        .map(|(i, c)| bt::Water {
            temperature_k: c.temperature + 0.001 * (i % 7) as f64,
            density_kg_m3: m.density,
            saturation_temperature_k: m.saturation,
        })
        .collect::<Vec<_>>();
    let zero = y.iter().map(|_| 0.).collect::<Vec<_>>();
    let dtemps = vec![0.; temperatures.len()];
    let zwater = vec![
        ms::Stocks {
            water_mass: 0.,
            liquid_volume: 0.,
            hydrogen_target: 0.,
            hydrogen_product: 0.,
            mobile_boron10: 0.
        };
        water.len()
    ];
    let mut elapsed = [0.; 6];
    let t = Instant::now();
    m.source
        .evaluate_with_geometry_into(y, temperatures, &water, &g, sw)?;
    elapsed[0] = t.elapsed().as_secs_f64();
    let source = sw.rates()?.to_vec();
    let diag = sw.diagnostics()?;
    let neutron_ledger = receipt(
        source[..m.source.nc_dimension()]
            .iter()
            .copied()
            .chain([-source[m.source.ledger_row()]]),
        "SOURCE neutron event ledger",
    )?
    .0;
    let t = Instant::now();
    m.absorber
        .evaluate_with_geometry(&host_t, sw, y, &wet, &s.value.contacts, aw)?;
    m.mobile.evaluate_with_geometry(
        &m.source,
        sw.water_birth_events()?,
        &vec![m.density; water.len()],
        &s.value.mobile,
        mw,
    )?;
    elapsed[1] = t.elapsed().as_secs_f64();
    let absorber = ag_fields(&aw.value);
    let mobile = mobile_fields(mw.value()?);
    let mut receipts = vec![
        receipt(
            aw.value
                .host
                .iter()
                .chain(&aw.value.water)
                .copied()
                .chain([aw.value.exported, -aw.value.emitted]),
            "BODY/guide finite heat",
        )?
        .0,
    ];
    let paid = m
        .absorber
        .paid_rows()
        .map(|(r, q)| q * source[r])
        .sum::<f64>();
    receipts.push(receipt([paid, -aw.value.emitted], "BODY/guide paid source")?.0);
    let mv = mw.value()?;
    receipts.push(
        receipt(
            mv.recipient_power()
                .chain([mv.exported, mv.boundary_exported])
                .chain(mv.channels.chunks_exact(6).map(|v| -v[0])),
            "Mobile finite heat",
        )?
        .0,
    );
    for channel in mv.channels.chunks_exact(6) {
        receipt(
            channel[1..].iter().copied().chain([-channel[0]]),
            "Mobile local channel",
        )?;
    }
    let t = Instant::now();
    m.source
        .jvp_with_geometry_into(&zero, &dtemps, &dwater, &dg, sw)?;
    m.absorber.jvp_with_geometry_direction(
        &vec![0.; host_t.len()],
        sw,
        &zero,
        &vec![bt::WaterDirection::default(); water.len()],
        &s.direction.contacts,
        aw,
    )?;
    m.mobile.jvp_with_geometry_direction(
        sw.water_birth_event_jvp()?,
        &vec![0.; water.len()],
        &s.direction.mobile,
        mw,
    )?;
    elapsed[2] = t.elapsed().as_secs_f64();
    let dsource = sw.rate_jvp()?.to_vec();
    let dabsorber = ag_fields(&aw.direction);
    let dmobile = mobile_fields(mw.direction()?);
    let dexternal = sw
        .external_water_event_jvp()?
        .iter()
        .flat_map(|e| [e.hydrogen, e.boron, e.emitted_charged, e.emitted_photon])
        .collect::<Vec<_>>();
    let t = Instant::now();
    let operators = m
        .operators
        .evaluate(&m.source, y, temperatures, &water, &g, &dwater, &dg)?;
    if operators.source_direction.len() != dsource.len()
        || operators.external_direction.len() != water.len()
    {
        return Err("Independent operator assembly dimensions differ".into());
    }
    let mut assembly_source = Error::default();
    for (i, (&a, &b)) in dsource.iter().zip(&operators.source_direction).enumerate() {
        assembly_source.add(
            i,
            a,
            b,
            if m.source.is_energy_row(i) {
                1e-6
            } else {
                1e-3
            },
            1e-5,
        )?;
    }
    let mut assembly_external = Error::default();
    for (i, (a, b)) in sw
        .external_water_event_jvp()?
        .iter()
        .zip(&operators.external_direction)
        .enumerate()
    {
        for (j, (a, b)) in [a.hydrogen, a.boron, a.emitted_charged, a.emitted_photon]
            .into_iter()
            .zip([b.hydrogen, b.boron, b.emitted_charged, b.emitted_photon])
            .enumerate()
        {
            assembly_external.add(4 * i + j, a, b, if j < 2 { 1e-3 } else { 1e-6 }, 1e-5)?;
        }
    }
    elapsed[5] = t.elapsed().as_secs_f64();
    if assembly_source.ratio > 1. || assembly_external.ratio > 1. {
        return Err(format!(
            "Independent geometry chain assembly differs: source {} external {}",
            assembly_source.json(),
            assembly_external.json()
        ));
    }
    receipts.push(
        receipt(
            aw.direction
                .host
                .iter()
                .chain(&aw.direction.water)
                .copied()
                .chain([aw.direction.exported, -aw.direction.emitted]),
            "BODY/guide finite heat direction",
        )?
        .0,
    );
    let mv = mw.direction()?;
    receipts.push(
        receipt(
            mv.recipient_power()
                .chain([mv.exported, mv.boundary_exported])
                .chain(mv.channels.chunks_exact(6).map(|v| -v[0])),
            "Mobile finite heat direction",
        )?
        .0,
    );
    let t = Instant::now();
    let mut nv = vec![0.; m.source.nc_pattern().len()];
    m.source.nc_values(sw, 0., &mut nv)?;
    let mut dy = vec![0.; y.len()];
    for (i, d) in dy[..m.source.nc_dimension()].iter_mut().enumerate() {
        *d = 0.03 * (i as f64 + 1.).sin();
    }
    m.source.jvp_coupled_into(&dy, &dtemps, &zwater, sw)?;
    let mut product = vec![0.; m.source.nc_dimension()];
    for (&(r, c), &a) in m.source.nc_pattern().iter().zip(&nv) {
        product[r] -= a * dy[c];
    }
    let mut nc = Error::default();
    for (i, (&a, &b)) in product.iter().zip(sw.rate_jvp()?).enumerate() {
        nc.add(i, a, b, 1e-9, 2e-11)?;
    }
    elapsed[3] = t.elapsed().as_secs_f64();
    check_deadline(deadline)?;
    let t = Instant::now();
    let mut jv = vec![0.; m.jacobian.pattern().len()];
    m.jacobian.values(&m.source, sw, 1., &mut jv)?;
    for (i, d) in dy.iter_mut().enumerate() {
        *d = 0.03 * (0.17 * i as f64 + 1.).sin();
    }
    m.source.jvp_coupled_into(&dy, &dtemps, &zwater, sw)?;
    let mut product = dy.clone();
    for (&(r, c), &a) in m.jacobian.pattern().iter().zip(&jv) {
        product[r] -= a * dy[c];
    }
    let mut csc = Error::default();
    for (i, (&a, &b)) in product.iter().zip(sw.rate_jvp()?).enumerate() {
        csc.add(i, a, b, 1e-9, 2e-11)?;
    }
    elapsed[4] = t.elapsed().as_secs_f64();
    if nc.ratio > 1. || csc.ratio > 1. {
        return Err(format!(
            "Held-geometry operator mismatch NC {} CSC {}",
            nc.json(),
            csc.json()
        ));
    }
    Ok(ResultStage {
        source,
        dsource,
        absorber,
        dabsorber,
        mobile,
        dmobile,
        dexternal,
        receipts,
        operators,
        assembly_source,
        assembly_external,
        nc,
        csc,
        elapsed,
        captures: diag.capture_events_s,
        neutron_ledger,
    })
}
fn numbers(v: &[f64]) -> String {
    v.iter()
        .map(|x| format!("{x:.17e}"))
        .collect::<Vec<_>>()
        .join(" ")
}
fn store(path: &Path, r: &ResultStage) -> Result<(), String> {
    let fields = [
        ("source", &r.source),
        ("source_direction", &r.dsource),
        ("absorber", &r.absorber),
        ("absorber_direction", &r.dabsorber),
        ("mobile", &r.mobile),
        ("mobile_direction", &r.dmobile),
        ("external_event_direction", &r.dexternal),
        ("operator_coefficients", &r.operators.coefficients),
        ("operator_direction", &r.operators.direction),
        (
            "independently_assembled_source_direction",
            &r.operators.source_direction,
        ),
    ];
    let mut text = String::new();
    for (name, v) in fields {
        text.push_str(&format!("{name} {}\n{}\n", v.len(), numbers(v)));
    }
    let external = r
        .operators
        .external_direction
        .iter()
        .flat_map(|e| [e.hydrogen, e.boron, e.emitted_charged, e.emitted_photon])
        .collect::<Vec<_>>();
    text.push_str(&format!(
        "independently_assembled_external_direction {}\n{}\n",
        external.len(),
        numbers(&external)
    ));
    fs::write(path, text).map_err(|e| e.to_string())
}
fn difference(a: &[f64], b: &[f64]) -> (usize, f64) {
    a.iter().zip(b).fold((0, 0_f64), |(n, m), (&a, &b)| {
        (
            n + usize::from(a.to_bits() != b.to_bits()),
            m.max((a - b).abs()),
        )
    })
}
fn same_bits(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.to_bits() == b.to_bits())
}
fn run(text: &str, budget: f64, epsilon: f64, artifact: &Path) -> Result<String, String> {
    if !budget.is_finite() || budget <= 0. || !epsilon.is_finite() || epsilon <= 0. {
        return Err("Invalid stage budget/difference step".into());
    }
    let started = Instant::now();
    let deadline = started + std::time::Duration::from_secs_f64(budget);
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    let mut w = tokens.iter().copied();
    let frames = (0..6).map(|_| framed(&mut w)).collect::<Vec<_>>();
    if w.next().is_some() {
        return Err("Trailing current SOURCE frames".into());
    }
    let mut m = Model::prepare(&frames[0].join(" "), &frames[1], &frames[2], &frames[3])?;
    let mut ow = frames[4].iter().copied();
    let original = stage(&mut ow);
    if ow.next().is_some() {
        return Err("Trailing ORIGINAL stage".into());
    }
    let mut cw = frames[5].iter().copied();
    let n = count(&mut cw);
    if n != 6 {
        return Err("This qualification requires six explicit cases".into());
    }
    let stages = (0..n).map(|_| stage(&mut cw)).collect::<Vec<_>>();
    if cw.next().is_some() {
        return Err("Trailing current stage cases".into());
    }
    let mut y = m.source.initial_state();
    for (i, x) in y[..m.source.nc_dimension()].iter_mut().enumerate() {
        *x = 1000. + 7. * (i % 29) as f64;
    }
    let bits = y.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    let mut sw = m.source.workspace();
    let mut aw = m.absorber.workspace();
    let mut mw = m.mobile.workspace();
    let setup_s = started.elapsed().as_secs_f64();
    // Explicit ORIGINAL frame must coincide with the constructor geometry.
    if m.geometry(&original.value.source, false) != *m.source.prepared_geometry()
        || original.value.contacts != m.absorber.geometry()
        || original.value.mobile != *m.mobile.geometry()
    {
        return Err("Original frame and model preparation differ".into());
    }
    fs::create_dir_all(artifact).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for (i, s) in stages.iter().enumerate() {
        check_deadline(deadline)?;
        let r = evaluate(&mut m, s, &y, &mut sw, &mut aw, &mut mw, deadline)?;
        store(&artifact.join(format!("case-{i}.fields.txt")), &r)?;
        eprintln!(
            "CURRENT_SOURCE_STAGE case={i} elapsed_s={:.6} capture_s={:.9e}",
            started.elapsed().as_secs_f64(),
            r.captures
        );
        results.push(r);
    }
    let last = &results[5];
    let first = &results[0];
    let restored = same_bits(&first.source, &last.source)
        && same_bits(&first.absorber, &last.absorber)
        && same_bits(&first.mobile, &last.mobile)
        && same_bits(&first.dsource, &last.dsource)
        && same_bits(&first.dabsorber, &last.dabsorber)
        && same_bits(&first.dmobile, &last.dmobile)
        && same_bits(&first.dexternal, &last.dexternal)
        && same_bits(&first.operators.coefficients, &last.operators.coefficients)
        && same_bits(&first.operators.direction, &last.operators.direction)
        && same_bits(
            &first.operators.source_direction,
            &last.operators.source_direction,
        );
    if !restored || y.iter().map(|x| x.to_bits()).ne(bits) {
        return Err("Original/history restoration failed".into());
    }
    let mut source_counts = FiniteDifference::default();
    let mut source_energy = FiniteDifference::default();
    let mut absorber = FiniteDifference::default();
    let mut mobile = FiniteDifference::default();
    let middle = &results[2];
    let plus = &results[3];
    let minus = &results[4];
    let operator_check = OperatorCheck::new(
        &middle.operators,
        &plus.operators,
        &minus.operators,
        epsilon,
    )?;
    let (coefficient_index, &coefficient_signal) = middle
        .operators
        .direction
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .ok_or("Missing operator directions")?;
    let coefficient_negative = negative_control_at(coefficient_index, coefficient_signal, 1e-10)?;
    let assembly_negative = negative_control(&middle.dsource, |i| m.source.is_energy_row(i))?;
    for (i, &a) in middle.dsource.iter().enumerate() {
        if m.source.is_energy_row(i) {
            source_energy.add(i, a, plus.source[i], minus.source[i], epsilon, 1e-6, 1e-5)?;
        } else {
            source_counts.add(i, a, plus.source[i], minus.source[i], epsilon, 1e-3, 1e-5)?;
        }
    }
    for (i, &a) in middle.dabsorber.iter().enumerate() {
        absorber.add(
            i,
            a,
            plus.absorber[i],
            minus.absorber[i],
            epsilon,
            1e-6,
            1e-5,
        )?;
    }
    for (i, &a) in middle.dmobile.iter().enumerate() {
        mobile.add(i, a, plus.mobile[i], minus.mobile[i], epsilon, 1e-6, 1e-5)?;
    }
    // Malformed current geometry refuses and invalidates the source stage;
    // restoration then rebuilds the same coefficients, never another model.
    let mut invalid = m.geometry(&stages[2].value.source, false);
    invalid.passive_volumes[0] = -1.;
    let refused = m
        .source
        .evaluate_with_geometry_into(
            &y,
            m.source.prepared_temperatures(),
            &m.water(&stages[2].value)?,
            &invalid,
            &mut sw,
        )
        .is_err()
        && sw.rates().is_err();
    if !refused {
        return Err("Invalid current geometry was not refused/inactivated".into());
    }
    let errors = [&source_counts, &source_energy, &absorber, &mobile];
    // The huge assembled SOURCE count subtraction is retained as an explicitly
    // partial diagnostic. Its conditioning is not a permission to widen its
    // accuracy gate. Qualification instead requires every physical operator
    // derivative and the independently composed full SOURCE/event chain.
    let aggregate_fd_pass = errors.iter().all(|e| e.pass());
    let pass = operator_check.pass()
        && source_energy.pass()
        && absorber.pass()
        && mobile.pass()
        && results
            .iter()
            .all(|r| r.assembly_source.ratio <= 1. && r.assembly_external.ratio <= 1.);
    let fd_coverage = if errors.iter().all(|e| e.resolution_limited == 0) {
        "full"
    } else {
        "partial"
    };
    let cases=results.iter().enumerate().map(|(i,r)|{
        let ds=difference(&first.source,&r.source);let da=difference(&first.absorber,&r.absorber);let dm=difference(&first.mobile,&r.mobile);
        format!("{{\"index\":{i},\"capture_events_s\":{},\"changed\":{{\"source\":[{},{}],\"absorber\":[{},{}],\"mobile\":[{},{}]}},\"receipts\":[{}],\"nc\":{},\"csc\":{},\"independent_assembly\":{{\"source_checked\":{},\"external_event_fields_checked\":{},\"source\":{},\"external\":{}}},\"timing_s\":[{}]}}",r.captures,ds.0,ds.1,da.0,da.1,dm.0,dm.1,numbers(&r.receipts).replace(' ',","),r.nc.json(),r.csc.json(),r.dsource.len(),4*r.operators.external_direction.len(),r.assembly_source.json(),r.assembly_external.json(),numbers(&r.elapsed).replace(' ',","))
    }).collect::<Vec<_>>().join(",");
    Ok(format!(
        "{{\"pass\":{pass},\"qualification_basis\":\"full physical coefficient directions plus independently assembled full SOURCE/external-event JVP and finite-recipient derivatives\",\"scope\":\"current-geometry SOURCE and finite-recipient stage/derivative qualification; no advancement, advection, network residual or whole-plant throughput claim\",\"setup_s\":{setup_s},\"wall_s\":{},\"source_coordinates\":{},\"nc_coordinates\":{},\"primary_water_owners\":{},\"host_count\":{},\"mobile_routes\":{},\"original_restored\":{restored},\"history_bits_unchanged\":true,\"invalid_geometry_refused\":{refused},\"difference_step\":{epsilon},\"finite_difference_coverage\":\"{fd_coverage}\",\"aggregate_rhs_finite_difference\":{{\"acceptance_gate\":false,\"pass\":{aggregate_fd_pass},\"status\":\"partial/inconclusive; inspect unchanged raw and resolved errors\"}},\"minimum_output_resolution_is_not_full_roundoff_bound\":true,\"operator_finite_difference\":{},\"negative_controls\":{{\"coefficient\":{coefficient_negative},\"assembly\":{assembly_negative}}},\"timing_categories\":[\"fresh_source_value\",\"finite_recipient_values\",\"full_geometry_direction\",\"nc_values_and_operator_check\",\"full_csc_values_and_operator_check\",\"independent_coefficients_and_source_chain\"],\"finite_difference\":{{\"source_counts\":{},\"source_energy\":{},\"absorber\":{},\"mobile\":{}}},\"cases\":[{cases}]}}",
        started.elapsed().as_secs_f64(),
        m.source.state_count(),
        m.source.nc_dimension(),
        m.cells.len(),
        m.absorber.host_count(),
        m.mobile.route_count(),
        operator_check.json(),
        source_counts.json(),
        source_energy.json(),
        absorber.json(),
        mobile.json()
    ))
}
#[cfg(test)]
mod finite_difference_tests {
    use super::*;

    #[test]
    fn output_quantization_does_not_become_an_accuracy_waiver() {
        let mut result = FiniteDifference::default();
        result.add(3, 1., 1., -1., 1., 1e-6, 1e-5).unwrap();
        assert!(result.pass());
        assert_eq!(result.resolved, 1);
        // A well-resolved but wrong derivative must still fail.
        result.add(4, 2., 1., -1., 1., 1e-6, 1e-5).unwrap();
        assert!(!result.pass());
    }

    #[test]
    fn unresolved_subtraction_is_partial_not_qualified() {
        let mut result = FiniteDifference::default();
        result.add(7, 0.01, 1e15, 1e15, 1., 1e-6, 1e-5).unwrap();
        assert!(result.pass());
        assert_eq!(result.resolution_limited, 1);
        assert_eq!(result.resolved, 0);
        assert!(result.json().contains("\"coverage\":\"partial\""));
        assert_eq!(result.index, 7);
    }

    #[test]
    fn resolution_limited_cannot_hide_gross_zero_or_sign_error() {
        let mut zero = FiniteDifference::default();
        zero.add(1, 1., 1e15, 1e15, 1., 1e-6, 1e-5).unwrap();
        assert!(!zero.pass());
        assert_eq!(zero.gross_mismatches, 1);
        let mut sign = FiniteDifference::default();
        sign.add(2, -1., 1e15 + 1., 1e15 - 1., 1., 1e-6, 1e-5)
            .unwrap();
        assert!(!sign.pass());
        assert_eq!(sign.gross_mismatches, 1);
    }

    fn operator_stage(coefficient: f64, direction: f64) -> source_geometry::Stage {
        source_geometry::Stage {
            coefficients: vec![coefficient],
            direction: vec![direction],
            source_direction: Vec::new(),
            external_direction: Vec::new(),
            groups: vec![source_geometry::Group {
                name: "test physical coefficient",
                units: "m^-1",
                start: 0,
                end: 1,
            }],
        }
    }
    #[test]
    fn physical_operator_gate_rejects_missing_and_wrong_sign_directions() {
        let plus = operator_stage(0.508, 2.);
        let minus = operator_stage(0.492, 2.);
        let correct = operator_stage(0.5, 2.);
        assert!(OperatorCheck::new(&correct, &plus, &minus, 0.004)
            .unwrap()
            .pass());
        let omitted = operator_stage(0.5, 0.);
        let reversed = operator_stage(0.5, -2.);
        assert!(!OperatorCheck::new(&omitted, &plus, &minus, 0.004)
            .unwrap()
            .pass());
        assert!(!OperatorCheck::new(&reversed, &plus, &minus, 0.004)
            .unwrap()
            .pass());
    }
    #[test]
    fn physical_operator_groups_cannot_omit_zero_support_or_overlap() {
        let base = operator_stage(0., 0.);
        assert!(OperatorCheck::new(&base, &base, &base, 0.004)
            .unwrap()
            .pass());
        let mut omitted = operator_stage(0., 0.);
        omitted.groups.clear();
        assert!(OperatorCheck::new(&omitted, &base, &base, 0.004).is_err());
        let mut overlap = operator_stage(0., 0.);
        overlap.groups[0].start = 1;
        assert!(OperatorCheck::new(&overlap, &base, &base, 0.004).is_err());
    }
    #[test]
    fn negative_controls_require_real_signal_and_reject_both_mutations() {
        assert!(negative_control_at(3, 0., 1e-10).is_err());
        let witness = negative_control_at(3, 2., 1e-10).unwrap();
        assert!(witness.contains("\"omitted_rejected\":true"));
        assert!(witness.contains("\"reversed_rejected\":true"));
        let mut correct = Error::default();
        correct.add(3, 2., 2., 1e-3, 1e-5).unwrap();
        assert!(correct.ratio <= 1.);
    }
}
fn main() {
    let mut args = std::env::args().skip(1);
    let result = (|| {
        let budget = args
            .next()
            .ok_or("Missing explicit wall budget")?
            .parse::<f64>()
            .map_err(|_| "Invalid budget")?;
        let epsilon = args
            .next()
            .ok_or("Missing explicit difference step")?
            .parse::<f64>()
            .map_err(|_| "Invalid difference step")?;
        let artifacts = args.next().ok_or("Missing evidence directory")?;
        if args.next().is_some() {
            return Err("Trailing stage arguments".into());
        }
        let mut text = String::new();
        io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        run(&text, budget, epsilon, Path::new(&artifacts))
    })();
    match result {
        Ok(json) => {
            println!("{json}");
            if !json.starts_with("{\"pass\":true") {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("CURRENT_SOURCE_STAGE_FAILED {e}");
            std::process::exit(1);
        }
    }
}

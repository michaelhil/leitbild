//! Offline compatible mechanical projection of one finite horizontal passage.
//!
//! One water inventory owns a linear end-velocity field. Its conjugate momenta
//! w=C*v, C=M/6*[[2,1],[1,2]], retain both throughflow and dilation; they are not
//! two additional fluid masses. Native coordinates are [M,E,wL,wR,p,T].
//! The thermal chart uses rho(p,T)*A*L; K uses the INDEPENDENT trial M and w.
//! This explicit off-manifold contract differs from substituting chart M in K.
//!
//! Supplied donor p/T are independent stable-liquid EOS inputs, NOT a donor,
//! acceleration, pressure reconstruction or connected-network closure. End
//! velocities come from the owned momenta; q=rho_face*A*v uses the same volume
//! flow as pressure work. Linear mass-flux and velocity interpolants define a
//! compatible numerical projection, not an exact pointwise rho_bulk*v field.
//! No acoustic filter, phase/event law, elevation-changing pipe, or trajectory
//! is implemented. Entropy defect is exposed, never repaired with heat.
//! This API is adiabatic: external heat/shaft-power receipt is exactly absent.
//! Traction pressure is separate from the transported bulk donor p/T. This
//! upwind numerical reconstruction is NOT a static EOS face at that traction.
//! Traction and h=u+p_traction/rho_donor consume the same mechanical pressure. The
//! forward potential's signed pressure closure defect is retained separately;
//! it must not become a noisy hidden traction law or an extra heater.
use crate::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch, storage};

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub area: f64,
    pub length: f64,
    pub elevation: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Trial {
    pub mass: f64,
    pub energy: f64,
    pub momentum_left: f64,
    pub momentum_right: f64,
    pub pressure: f64,
    pub temperature: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Derivative {
    pub mass: f64,
    pub energy: f64,
    pub momentum_left: f64,
    pub momentum_right: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Face {
    pub donor_pressure: f64,
    pub donor_temperature: f64,
    pub traction_pressure: f64,
}

/// Already projected stationary passive forces. No Darcy coefficient, wall law
/// or hidden split is selected here. Their actual law derivatives belong to
/// the graph; the LOCAL Jacobian below holds these receipts fixed.
#[derive(Clone, Copy, Debug, Default)]
pub struct ForceReceipts {
    pub left: f64,
    pub right: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub geometry: Geometry,
    pub trial: Trial,
    pub derivative: Derivative,
    pub left: Face,
    pub right: Face,
    pub force: ForceReceipts,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Rates {
    pub mass: f64,
    pub energy: f64,
    pub momentum_left: f64,
    pub momentum_right: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Evaluation {
    /// Rows: M, E, wL, wR balances, then mass and total-energy charts.
    pub residual: [f64; 6],
    /// Columns: M,E,wL,wR,p,T,pDonorL,TDonorL,pTractionL,
    /// pDonorR,TDonorR,pTractionR. The first six columns
    /// include cj*F_ydot; geometry/force receipts are held fixed. A graph must
    /// add face constraints and derivatives of its actual force law.
    pub jacobian: [[f64; 12]; 6],
    pub chart_mass: f64,
    pub chart_energy: f64,
    pub velocities: [f64; 2],
    pub mass_flows: [f64; 2],
    pub total_enthalpies: [f64; 2],
    pub kinetic_energy: f64,
    pub rates: Rates,
    pub kinetic_rate: f64,
    pub internal_energy_rate: f64,
    pub pressure_power: f64,
    pub passive_dissipation: f64,
    /// Constitutive entropy diagnostic applies on the admitted chart manifold.
    /// It is not a passivity/accuracy admission of the supplied face map.
    pub entropy_rate: f64,
    pub advected_entropy_rate: f64,
    pub entropy_defect: f64,
    pub relative_availability: [f64; 2],
    pub forward_pressure_defects: [f64; 3],
}

#[derive(Debug)]
pub struct BlockError {
    /// Property tuple identity if applicable: 0 bulk, 1 left, 2 right.
    pub index: usize,
    pub message: String,
}

fn failure(message: impl Into<String>) -> BlockError {
    BlockError {
        index: 0,
        message: message.into(),
    }
}

/// One forward batched EOS evaluation; no stock/face inverse or warm-state
/// cache. Fixed-size caller-local arrays allocate no successful hot-path heap.
pub fn evaluate(input: Input, cj: f64) -> Result<Evaluation, BlockError> {
    validate(input, cj)?;
    let queries = [
        LiquidQuery {
            pressure: input.trial.pressure,
            temperature: input.trial.temperature,
        },
        LiquidQuery {
            pressure: input.left.donor_pressure,
            temperature: input.left.donor_temperature,
        },
        LiquidQuery {
            pressure: input.right.donor_pressure,
            temperature: input.right.donor_temperature,
        },
    ];
    let mut liquids = [Liquid::default(); 3];
    liquid_batch(&queries, &mut liquids).map_err(|e| BlockError {
        index: e.index,
        message: e.message,
    })?;
    evaluate_with_liquids(input, cj, liquids)
}

fn validate(input: Input, cj: f64) -> Result<(), BlockError> {
    let g = input.geometry;
    let y = input.trial;
    let d = input.derivative;
    let f = input.force;
    if ![
        g.area,
        g.length,
        g.elevation,
        y.mass,
        y.energy,
        y.momentum_left,
        y.momentum_right,
        y.pressure,
        y.temperature,
        d.mass,
        d.energy,
        d.momentum_left,
        d.momentum_right,
        input.left.donor_pressure,
        input.left.donor_temperature,
        input.left.traction_pressure,
        input.right.donor_pressure,
        input.right.donor_temperature,
        input.right.traction_pressure,
        f.left,
        f.right,
        cj,
    ]
    .iter()
    .all(|x| x.is_finite())
        || g.area <= 0.0
        || g.length <= 0.0
        || y.mass <= 0.0
        || input.left.traction_pressure <= 0.0
        || input.right.traction_pressure <= 0.0
    {
        return Err(failure(
            "Nonfinite or inadmissible horizontal-passage input",
        ));
    }
    let volume = g.area * g.length;
    let vl = (4.0 * y.momentum_left - 2.0 * y.momentum_right) / y.mass;
    let vr = (4.0 * y.momentum_right - 2.0 * y.momentum_left) / y.mass;
    let kinetic = 2.0
        * (y.momentum_left * y.momentum_left - y.momentum_left * y.momentum_right
            + y.momentum_right * y.momentum_right)
        / y.mass;
    let force_power = vl * f.left + vr * f.right;
    if ![volume, vl, vr, kinetic, force_power]
        .iter()
        .all(|x| x.is_finite())
        || volume <= 0.0
        || kinetic < 0.0
    {
        return Err(failure("Nonfinite passage metric or force work"));
    }
    if force_power > 0.0 {
        return Err(failure(
            "Stationary passive force receipt supplies positive mechanical work",
        ));
    }
    Ok(())
}

// Internal finite-neighbor assembly shares its actually evaluated property
// tuples; this is not an unchecked public property-provider/backend boundary.
pub(crate) fn evaluate_with_liquids(
    input: Input,
    cj: f64,
    liquids: [Liquid; 3],
) -> Result<Evaluation, BlockError> {
    validate(input, cj)?;
    let g = input.geometry;
    let y = input.trial;
    let d = input.derivative;
    let f = input.force;
    let volume = g.area * g.length;
    let vl = (4.0 * y.momentum_left - 2.0 * y.momentum_right) / y.mass;
    let vr = (4.0 * y.momentum_right - 2.0 * y.momentum_left) / y.mass;
    let kinetic = 2.0
        * (y.momentum_left * y.momentum_left - y.momentum_left * y.momentum_right
            + y.momentum_right * y.momentum_right)
        / y.mass;
    let force_power = vl * f.left + vr * f.right;
    let [bulk, left, right] = liquids;
    let cell = CellGeometry {
        volume,
        elevation: g.elevation,
    };
    let chart = storage(cell, bulk, 0.0, 0.0).map_err(failure)?;
    let chart_mass = chart.mass;
    let gz = GRAVITY * g.elevation;
    let thermal_energy = chart.energy;
    let ql = left.density * g.area * vl;
    let qr = right.density * g.area * vr;
    let hl =
        left.internal_energy + input.left.traction_pressure / left.density + vl * vl / 2.0 + gz;
    let hr =
        right.internal_energy + input.right.traction_pressure / right.density + vr * vr / 2.0 + gz;
    let transport = (ql * (2.0 * vl + vr) + qr * (vl + 2.0 * vr)) / 6.0;
    let rates = Rates {
        mass: ql - qr,
        energy: ql * hl - qr * hr,
        momentum_left: ql * vl - transport
            + g.area * (input.left.traction_pressure - y.pressure)
            + f.left,
        momentum_right: transport - qr * vr
            + g.area * (y.pressure - input.right.traction_pressure)
            + f.right,
    };
    let kinetic_rate =
        vl * rates.momentum_left + vr * rates.momentum_right - kinetic / y.mass * rates.mass;
    let internal_energy_rate = rates.energy - kinetic_rate - gz * rates.mass;
    let pressure_power = g.area
        * (input.left.traction_pressure * vl
            - input.right.traction_pressure * vr
            - y.pressure * (vl - vr));
    let chemical =
        bulk.internal_energy + y.pressure / bulk.density - bulk.temperature * bulk.entropy;
    let entropy_rate = (internal_energy_rate - chemical * rates.mass) / bulk.temperature;
    let advected_entropy_rate = ql * left.entropy - qr * right.entropy;
    let availability = |face: Liquid| {
        face.internal_energy
            - bulk.internal_energy
            - bulk.temperature * (face.entropy - bulk.entropy)
            + y.pressure * (1.0 / face.density - 1.0 / bulk.density)
    };

    // Analytic chain rule on all native and independent face coordinates.
    let mut j = [[0.0; 12]; 6];
    for column in 0..12 {
        let mut dvl = 0.0;
        let mut dvr = 0.0;
        match column {
            0 => {
                dvl = -vl / y.mass;
                dvr = -vr / y.mass;
            }
            2 => {
                dvl = 4.0 / y.mass;
                dvr = -2.0 / y.mass;
            }
            3 => {
                dvl = -2.0 / y.mass;
                dvr = 4.0 / y.mass;
            }
            _ => {}
        }
        let drhol = match column {
            6 => left.density * left.compressibility,
            7 => -left.density * left.expansion,
            _ => 0.0,
        };
        let drhor = match column {
            9 => right.density * right.compressibility,
            10 => -right.density * right.expansion,
            _ => 0.0,
        };
        let dql = g.area * (drhol * vl + left.density * dvl);
        let dqr = g.area * (drhor * vr + right.density * dvr);
        let dhl = vl * dvl
            + match column {
                6 => {
                    ((input.left.donor_pressure - input.left.traction_pressure)
                        * left.compressibility
                        - left.temperature * left.expansion)
                        / left.density
                }
                7 => {
                    left.cp
                        - (input.left.donor_pressure - input.left.traction_pressure)
                            * left.expansion
                            / left.density
                }
                8 => 1.0 / left.density,
                _ => 0.0,
            };
        let dhr = vr * dvr
            + match column {
                9 => {
                    ((input.right.donor_pressure - input.right.traction_pressure)
                        * right.compressibility
                        - right.temperature * right.expansion)
                        / right.density
                }
                10 => {
                    right.cp
                        - (input.right.donor_pressure - input.right.traction_pressure)
                            * right.expansion
                            / right.density
                }
                11 => 1.0 / right.density,
                _ => 0.0,
            };
        let dt = (dql * (2.0 * vl + vr)
            + ql * (2.0 * dvl + dvr)
            + dqr * (vl + 2.0 * vr)
            + qr * (dvl + 2.0 * dvr))
            / 6.0;
        let dp = if column == 4 { 1.0 } else { 0.0 };
        let dpl = if column == 8 { 1.0 } else { 0.0 };
        let dpr = if column == 11 { 1.0 } else { 0.0 };
        j[0][column] = -dql + dqr;
        j[1][column] = -dql * hl - ql * dhl + dqr * hr + qr * dhr;
        j[2][column] = -dql * vl - ql * dvl + dt - g.area * (dpl - dp);
        j[3][column] = -dt + dqr * vr + qr * dvr - g.area * (dp - dpr);
    }
    j[0][0] += cj;
    j[1][1] += cj;
    j[2][2] += cj;
    j[3][3] += cj;
    // Prescribed p is the physical numerical coordinate; returned potential
    // pressure differs by the separately exposed finite EOS closure residual.
    // These are continuous constitutive tangents, not derivatives of stopping
    // jitter in the dense-property recovery.
    let mp = chart_mass * bulk.compressibility;
    let mt = -chart_mass * bulk.expansion;
    let up = (y.pressure * bulk.compressibility - bulk.temperature * bulk.expansion) / bulk.density;
    let ut = bulk.cp - y.pressure * bulk.expansion / bulk.density;
    j[4][0] = 1.0;
    j[4][4] = -mp;
    j[4][5] = -mt;
    j[5][0] = kinetic / y.mass;
    j[5][1] = 1.0;
    j[5][2] = -vl;
    j[5][3] = -vr;
    j[5][4] = -(mp * (bulk.internal_energy + gz) + chart_mass * up);
    j[5][5] = -(mt * (bulk.internal_energy + gz) + chart_mass * ut);
    let result = Evaluation {
        residual: [
            d.mass - rates.mass,
            d.energy - rates.energy,
            d.momentum_left - rates.momentum_left,
            d.momentum_right - rates.momentum_right,
            y.mass - chart_mass,
            y.energy - thermal_energy - kinetic,
        ],
        jacobian: j,
        chart_mass,
        chart_energy: thermal_energy + kinetic,
        velocities: [vl, vr],
        mass_flows: [ql, qr],
        total_enthalpies: [hl, hr],
        kinetic_energy: kinetic,
        rates,
        kinetic_rate,
        internal_energy_rate,
        pressure_power,
        passive_dissipation: -force_power,
        entropy_rate,
        advected_entropy_rate,
        entropy_defect: entropy_rate - advected_entropy_rate,
        relative_availability: [availability(left), availability(right)],
        forward_pressure_defects: [
            bulk.pressure - y.pressure,
            left.pressure - input.left.donor_pressure,
            right.pressure - input.right.donor_pressure,
        ],
    };
    if !result
        .residual
        .iter()
        .chain(result.jacobian.iter().flatten())
        .chain(
            [
                result.chart_mass,
                result.chart_energy,
                vl,
                vr,
                ql,
                qr,
                hl,
                hr,
                kinetic,
                rates.mass,
                rates.energy,
                rates.momentum_left,
                rates.momentum_right,
                kinetic_rate,
                internal_energy_rate,
                pressure_power,
                result.passive_dissipation,
                entropy_rate,
                advected_entropy_rate,
                result.entropy_defect,
                result.relative_availability[0],
                result.relative_availability[1],
                result.forward_pressure_defects[0],
                result.forward_pressure_defects[1],
                result.forward_pressure_defects[2],
            ]
            .iter(),
        )
        .all(|x| x.is_finite())
    {
        return Err(failure(
            "Nonfinite horizontal-passage residual, tangent or diagnostic",
        ));
    }
    Ok(result)
}

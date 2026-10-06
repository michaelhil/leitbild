//! Offline finite all-liquid mixed header ↔ horizontal RETURN entrance.
//!
//! Coordinates/rows: [Mh,Eh,ph,Th,Md,Ed,W,pd,Td]. W is the LEFT conjugate
//! momentum wL, NOT total momentum. A diagnostic stationary seal at the remote
//! duct plane enforces vR=0, wR=W/2, vL=3W/Md, K=3W²/(2Md). Its reaction does
//! zero work. Other actual header ports are diagnostic sealed boundaries here;
//! this is not physical LD-01 alignment, DOWN or a circulating primary model.
//!
//! Material is reconstructed from the actual upstream BULK EOS; mechanical
//! traction is separate. This frozen-donor-density numerical approximation is
//! not a static EOS face. Forward traction pays outgoing stream K exactly;
//! reverse entry thermalizes stream K in the finite no-mean-motion header.
//! No maintained pressure/temperature, heat source, drag or extra inventory.
//! Fresh uniform all-liquid header scope cannot reset a reached axial field.
//!
//! KNOWN QUALIFICATION LIMITS: the frozen-density entrance exceeded its
//! prospective compressible-nozzle comparison screens at 20.5 MPa / 640 K
//! and 24 or 30 m/s. Positive traction and the frozen-temperature liquid guard
//! do NOT bound that approximation error. The sealed finite-pair IDA witness
//! also refused its state-entropy screen before its horizon; local reciprocal
//! work/entropy identities are not a qualified temporal solution. This block
//! retains fast compressible compliance modes, not a sound-filtered operating
//! pressure network. Neither failed qualification is repaired or hidden here.
use crate::{
    CellGeometry, GRAVITY, Liquid, LiquidQuery, horizontal_passage, liquid_batch, storage,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowBranch {
    /// Includes W=0: the declared forward one-sided continuation, not a smooth
    /// Jacobian across unequal donor states.
    HeaderToDuct,
    DuctToHeader,
}

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub header_geometry: CellGeometry,
    pub passage: horizontal_passage::Geometry,
    pub trial: [f64; 9],
    /// All finite; only Mh,Eh,Md,Ed,W rates enter differential rows.
    pub derivative: [f64; 9],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Evaluation {
    pub residual: [f64; 9],
    pub jacobian: [[f64; 9]; 9],
    /// Physical rates in [Mh,Eh,Md,Ed,W] order, not algebraic-coordinate rates.
    pub rates: [f64; 5],
    pub header_chart_mass: f64,
    pub header_chart_energy: f64,
    pub duct_chart_mass: f64,
    pub duct_chart_energy: f64,
    pub mass_flow: f64,
    pub total_enthalpy: f64,
    pub traction_pressure: f64,
    pub velocity: f64,
    pub kinetic_energy: f64,
    pub wall_reaction: f64,
    pub header_entropy_rate: f64,
    pub duct_entropy_rate: f64,
    pub entropy_production: f64,
    pub expected_entropy_production: f64,
    /// Bulk potential p minus prescribed p: [header,duct], signed/unfloored.
    pub forward_pressure_defects: [f64; 2],
    /// Number of requested forward tuples in this evaluation (2 or 3), not
    /// internal fundamental/property iteration count or accepted solver work.
    pub property_tuple_requests: usize,
    pub branch: FlowBranch,
}

impl Default for FlowBranch {
    fn default() -> Self {
        Self::HeaderToDuct
    }
}

#[derive(Debug)]
pub struct BlockError {
    /// Forward batch index: 0 header, 1 duct, 2 frozen-temperature guard.
    pub index: usize,
    pub property_tuple_requests: usize,
    pub message: String,
}

fn failure(index: usize, requests: usize, message: impl Into<String>) -> BlockError {
    BlockError {
        index,
        property_tuple_requests: requests,
        message: message.into(),
    }
}

pub fn evaluate(input: Input, cj: f64) -> Result<Evaluation, BlockError> {
    let h = input.header_geometry;
    let g = input.passage;
    let y = input.trial;
    let d = input.derivative;
    if !y
        .iter()
        .chain(d.iter())
        .chain([h.volume, h.elevation, g.area, g.length, g.elevation, cj].iter())
        .all(|x| x.is_finite())
        || h.volume <= 0.0
        || g.area <= 0.0
        || g.length <= 0.0
        || y[0] <= 0.0
        || y[4] <= 0.0
        || h.elevation != g.elevation
    {
        return Err(failure(
            0,
            0,
            "Invalid finite header/RETURN stocks, geometry, shared elevation or cj",
        ));
    }
    let mut liquids = [Liquid::default(); 2];
    liquid_batch(
        &[
            LiquidQuery {
                pressure: y[2],
                temperature: y[3],
            },
            LiquidQuery {
                pressure: y[7],
                temperature: y[8],
            },
        ],
        &mut liquids,
    )
    .map_err(|e| failure(e.index, 2, e.message))?;
    let [header, duct] = liquids;
    let v = 3.0 * y[6] / y[4];
    let forward = v >= 0.0;
    let branch = if forward {
        FlowBranch::HeaderToDuct
    } else {
        FlowBranch::DuctToHeader
    };
    let donor = if forward { header } else { duct };
    let donor_pressure = if forward { y[2] } else { y[7] };
    let donor_temperature = if forward { y[3] } else { y[8] };
    let pf = if forward {
        y[2] - header.density * v * v / 2.0
    } else {
        y[2]
    };
    if !v.is_finite() || !pf.is_finite() || pf <= 0.0 {
        return Err(failure(
            2,
            2,
            "Unsupported nonpositive or nonfinite entrance traction pressure/velocity",
        ));
    }
    let mut requests = 2;
    if pf != donor_pressure {
        // Applicability witness ONLY: this tuple is not a transported static
        // face, an isentropic inversion or a general cavitation/phase law.
        // Conservatively refuse a frozen-temperature stable-liquid exit.
        requests += 1;
        let mut guard = [Liquid::default()];
        liquid_batch(
            &[LiquidQuery {
                pressure: pf,
                temperature: donor_temperature,
            }],
            &mut guard,
        )
        .map_err(|e| {
            failure(
                2,
                requests,
                format!(
                    "Entrance frozen-temperature liquid applicability: {}",
                    e.message
                ),
            )
        })?;
    }
    let header_chart = storage(h, header, 0.0, 0.0).map_err(|e| failure(0, requests, e))?;
    let passage_input = horizontal_passage::Input {
        geometry: g,
        trial: horizontal_passage::Trial {
            mass: y[4],
            energy: y[5],
            momentum_left: y[6],
            momentum_right: y[6] / 2.0,
            pressure: y[7],
            temperature: y[8],
        },
        derivative: horizontal_passage::Derivative {
            mass: d[4],
            energy: d[5],
            momentum_left: d[6],
            momentum_right: d[6] / 2.0,
        },
        left: horizontal_passage::Face {
            donor_pressure,
            donor_temperature,
            traction_pressure: pf,
        },
        right: horizontal_passage::Face {
            donor_pressure: y[7],
            donor_temperature: y[8],
            traction_pressure: y[7],
        },
        force: horizontal_passage::ForceReceipts::default(),
    };
    let passage = horizontal_passage::evaluate_with_liquids(passage_input, cj, [duct, donor, duct])
        .map_err(|e| {
            failure(
                1,
                requests,
                format!("Finite RETURN projection: {}", e.message),
            )
        })?;
    let q = passage.mass_flows[0];
    let energy = passage.rates.energy;
    let wdot = passage.rates.momentum_left;
    let wall_reaction = wdot / 2.0 - passage.rates.momentum_right;
    let gz = GRAVITY * h.elevation;
    let hh = header.internal_energy + y[2] / header.density;
    let chemical = hh - header.temperature * header.entropy;
    let header_entropy_rate = (-energy + (gz + chemical) * q) / header.temperature;
    let duct_entropy_rate = passage.entropy_rate;
    let availability = if forward {
        header.internal_energy
            - duct.internal_energy
            - duct.temperature * (header.entropy - duct.entropy)
            + y[7] * (1.0 / header.density - 1.0 / duct.density)
    } else {
        duct.internal_energy
            - header.internal_energy
            - header.temperature * (duct.entropy - header.entropy)
            + y[2] * (1.0 / duct.density - 1.0 / header.density)
    };
    let expected_entropy_production = if forward {
        q * availability / duct.temperature
    } else {
        -q * (availability + v * v / 2.0) / header.temperature
    };

    // Complete local chain rule from the 12-coordinate passage to the nine
    // finite-neighbor coordinates. No finite differences or hidden face solve.
    let mut map = [[0.0; 9]; 12];
    map[0][4] = 1.0;
    map[1][5] = 1.0;
    map[2][6] = 1.0;
    map[3][6] = 0.5;
    map[4][7] = 1.0;
    map[5][8] = 1.0;
    if forward {
        map[6][2] = 1.0;
        map[7][3] = 1.0;
        map[8][2] = 1.0 - header.density * header.compressibility * v * v / 2.0;
        map[8][3] = header.density * header.expansion * v * v / 2.0;
        map[8][4] = header.density * v * v / y[4];
        map[8][6] = -header.density * v * 3.0 / y[4];
    } else {
        map[6][7] = 1.0;
        map[7][8] = 1.0;
        map[8][2] = 1.0;
    }
    map[9][7] = 1.0;
    map[10][8] = 1.0;
    map[11][7] = 1.0;
    let mut j = [[0.0; 9]; 9];
    for (row, passage_row) in [(4, 0), (5, 1), (6, 2), (7, 4), (8, 5)] {
        for column in 0..9 {
            j[row][column] = (0..12)
                .map(|k| passage.jacobian[passage_row][k] * map[k][column])
                .sum();
        }
    }
    // Header balances get the SAME signed material/energy receipt, opposite
    // incidence. Remove the duct differential cj before copying its rate J.
    for column in 0..9 {
        j[0][column] = -j[4][column] + if column == 4 { cj } else { 0.0 };
        j[1][column] = -j[5][column] + if column == 5 { cj } else { 0.0 };
    }
    j[0][0] += cj;
    j[1][1] += cj;
    let mp = header_chart.mass * header.compressibility;
    let mt = -header_chart.mass * header.expansion;
    let up =
        (y[2] * header.compressibility - header.temperature * header.expansion) / header.density;
    let ut = header.cp - y[2] * header.expansion / header.density;
    j[2][0] = 1.0;
    j[2][2] = -mp;
    j[2][3] = -mt;
    j[3][1] = 1.0;
    j[3][2] = -(mp * (header.internal_energy + gz) + header_chart.mass * up);
    j[3][3] = -(mt * (header.internal_energy + gz) + header_chart.mass * ut);
    let result = Evaluation {
        residual: [
            d[0] + q,
            d[1] + energy,
            y[0] - header_chart.mass,
            y[1] - header_chart.energy,
            passage.residual[0],
            passage.residual[1],
            passage.residual[2],
            passage.residual[4],
            passage.residual[5],
        ],
        jacobian: j,
        rates: [-q, -energy, q, energy, wdot],
        header_chart_mass: header_chart.mass,
        header_chart_energy: header_chart.energy,
        duct_chart_mass: passage.chart_mass,
        duct_chart_energy: passage.chart_energy,
        mass_flow: q,
        total_enthalpy: passage.total_enthalpies[0],
        traction_pressure: pf,
        velocity: v,
        kinetic_energy: passage.kinetic_energy,
        wall_reaction,
        header_entropy_rate,
        duct_entropy_rate,
        entropy_production: header_entropy_rate + duct_entropy_rate,
        expected_entropy_production,
        forward_pressure_defects: [header.pressure - y[2], duct.pressure - y[7]],
        property_tuple_requests: requests,
        branch,
    };
    if !result
        .residual
        .iter()
        .chain(result.jacobian.iter().flatten())
        .chain(result.rates.iter())
        .chain(
            [
                result.header_chart_mass,
                result.header_chart_energy,
                result.duct_chart_mass,
                result.duct_chart_energy,
                q,
                result.total_enthalpy,
                pf,
                v,
                result.kinetic_energy,
                wall_reaction,
                header_entropy_rate,
                duct_entropy_rate,
                result.entropy_production,
                expected_entropy_production,
                result.forward_pressure_defects[0],
                result.forward_pressure_defects[1],
            ]
            .iter(),
        )
        .all(|x| x.is_finite())
    {
        return Err(failure(
            0,
            requests,
            "Nonfinite finite header/RETURN residual, tangent or diagnostic",
        ));
    }
    Ok(result)
}

//! Selected local CMT mean transport. No integrator, seed or stage-origin policy.
//! Rates partition one native E; Q production is not additional total-energy heat.
use std::mem::{align_of, size_of};

pub const INPUTS: usize = 11;
pub const OUTPUTS: usize = 8;
pub const GRAVITY: f64 = 9.80665;
pub const DENSITY: usize = 0;
pub const VISCOSITY: usize = 1;
pub const K: usize = 2;
pub const SOUND_SQUARED: usize = 3;
pub const PRESSURE_GRADIENT: usize = 4;
pub const DENSITY_GRADIENT: usize = 5;
pub const AXIAL_STRAIN: usize = 6;
pub const TRANSVERSE_STRAIN: usize = 7;
pub const WALL_DISTANCE: usize = 8;
pub const OUTER_LENGTH: usize = 9;
pub const VISCOUS_LENGTH: usize = 10;

/// All values SI. Strains are du/dz and the selected mean transverse strain.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub density: f64,
    pub viscosity: f64,
    pub k: f64,
    pub sound_squared: f64,
    pub pressure_gradient: f64,
    pub density_gradient: f64,
    pub axial_strain: f64,
    pub transverse_strain: f64,
    pub wall_distance: f64,
    pub outer_length: f64,
    /// Positive region-bulk correlation scale, not a quadrature wall distance.
    pub viscous_length: f64,
}

/// Derivative meaning, not a persistent turbulence/physical mode flag.
pub const INTERIOR: u32 = 0;
pub const STABLE_ZERO_RIGHT: u32 = 1;
pub const ZERO_RIGHT: u32 = 2;
pub const LENGTH_TIE: u32 = 3;
pub const SIGNED_TRIAL: u32 = 4;
pub const SOLID_ZERO: u32 = 5;

/// Rows: nu, kappa, epsilon, G, production, tau_zz, tau_perp, source_Q/V.
/// Columns use the named Input indices above. Nonavailable matrices contain NaN,
/// never invented finite tangents. Stable-zero derivatives are physical RIGHT
/// limits, not the signed-trial left derivative or a global stage guarantee.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Output {
    pub rates: [f64; OUTPUTS],
    pub derivatives: [[f64; INPUTS]; OUTPUTS],
    pub derivative_status: u32,
    pub derivatives_available: u32,
}

pub fn evaluate(x: Input, numerical_trial: bool) -> Result<Output, &'static str> {
    let values = [
        x.density,
        x.viscosity,
        x.k,
        x.sound_squared,
        x.pressure_gradient,
        x.density_gradient,
        x.axial_strain,
        x.transverse_strain,
        x.wall_distance,
        x.outer_length,
        x.viscous_length,
    ];
    if !values.iter().all(|v| v.is_finite())
        || x.density <= 0.
        || x.viscosity <= 0.
        || x.sound_squared <= 0.
        || x.wall_distance < 0.
        || x.outer_length <= 0.
        || x.viscous_length <= 0.
        || (!numerical_trial && x.k < 0.)
    {
        return Err("Invalid local mixing input/accepted state");
    }
    if x.k > 0. && x.wall_distance == 0. {
        return Err("Positive mixing energy at actual solid wall");
    }
    let rho = x.density;
    let d = x.axial_strain - x.transverse_strain;
    let theta = x.axial_strain + 2. * x.transverse_strain;
    let contrast = x.density_gradient - x.pressure_gradient / x.sound_squared;
    let n2 = -GRAVITY / rho * contrast;
    if !n2.is_finite() {
        return Err("Nonfinite stable-length diagnostic");
    }
    let mut dn2 = [0.; INPUTS];
    dn2[DENSITY] = -n2 / rho;
    dn2[SOUND_SQUARED] = -GRAVITY * x.pressure_gradient / (rho * x.sound_squared.powi(2));
    dn2[PRESSURE_GRADIENT] = GRAVITY / (rho * x.sound_squared);
    dn2[DENSITY_GRADIENT] = -GRAVITY / rho;
    let mut nu = 0.;
    let mut kappa = 0.;
    let molecular_nu = x.viscosity / rho;
    let mut dmolecular = [0.; INPUTS];
    dmolecular[DENSITY] = -molecular_nu / rho;
    dmolecular[VISCOSITY] = 1. / rho;
    // Signed linear numerical extension is essential: no hidden k floor and no
    // stress/work mismatch. Negative accepted states are still rejected above.
    let molecular_decay = 2. * molecular_nu / x.viscous_length.powi(2);
    let mut epsilon = molecular_decay * x.k;
    let mut dnu = [0.; INPUTS];
    let mut dkappa = [0.; INPUTS];
    let mut depsilon = [0.; INPUTS];
    for j in 0..INPUTS {
        let dk = if j == K { 1. } else { 0. };
        let dell = if j == VISCOUS_LENGTH { 1. } else { 0. };
        depsilon[j] = molecular_decay * dk
            + 2. * x.k * dmolecular[j] / x.viscous_length.powi(2)
            - 2. * molecular_decay * x.k / x.viscous_length * dell;
    }
    let status;
    let available;
    if x.k > 0. {
        let wall = 0.7 * x.wall_distance;
        let mut l = x.outer_length.min(wall);
        let mut dl = [0.; INPUTS];
        let mut tie = wall == x.outer_length;
        let mut stable_selected = false;
        if x.outer_length <= wall {
            dl[OUTER_LENGTH] = 1.;
        } else {
            dl[WALL_DISTANCE] = 0.7;
        }
        if n2 > 0. {
            let stable = 0.76 * x.k.sqrt() / n2.sqrt();
            if stable < l {
                l = stable;
                tie = false;
                stable_selected = true;
            } else if stable == l {
                tie = true;
            }
        }
        if !(l.is_finite() && l > 0.) {
            return Err("Missing finite positive mixing length");
        }
        let root = x.k.sqrt();
        let reynolds;
        let mut dreynolds = [0.; INPUTS];
        if stable_selected {
            // Same law after cancelling l~sqrt(k). The O(k) terms must not be
            // lost by underflowing k^(3/2) before division by l.
            let n = n2.sqrt();
            let ab = 0.76 * 0.10;
            let extra = 2. * 0.76 * ab * x.k * root / (x.outer_length * n2);
            nu = ab * x.k / n;
            kappa = nu + extra;
            epsilon += 0.19 / 0.76 * n * x.k + 0.51 * x.k * root / x.outer_length;
            reynolds = 0.76 * x.k / (n * molecular_nu);
            for j in 0..INPUTS {
                let dk = if j == K { 1. } else { 0. };
                let outer = if j == OUTER_LENGTH { 1. } else { 0. };
                dnu[j] = ab / n * dk - ab * x.k / (2. * n2 * n) * dn2[j];
                dkappa[j] = dnu[j]
                    + 2. * 0.76 * ab / x.outer_length
                        * (1.5 * root / n2 * dk - x.k * root / n2.powi(2) * dn2[j])
                    - extra / x.outer_length * outer;
                depsilon[j] += 0.19 / 0.76 * (n * dk + x.k / (2. * n) * dn2[j])
                    + 0.51
                        * (1.5 * root / x.outer_length * dk
                            - x.k * root / x.outer_length.powi(2) * outer);
                dreynolds[j] = 0.76 / (n * molecular_nu) * dk
                    - reynolds / (2. * n2) * dn2[j]
                    - reynolds / molecular_nu * dmolecular[j];
            }
        } else {
            nu = 0.10 * l * root;
            kappa = (1. + 2. * l / x.outer_length) * nu;
            epsilon += (0.19 / l + 0.51 / x.outer_length) * x.k * root;
            reynolds = l * root / molecular_nu;
            for j in 0..INPUTS {
                let dk = if j == K { 1. } else { 0. };
                let outer = if j == OUTER_LENGTH { 1. } else { 0. };
                dnu[j] = 0.10 * root * dl[j] + 0.05 * l / root * dk;
                dkappa[j] = (1. + 2. * l / x.outer_length) * dnu[j]
                    + 2. * nu / x.outer_length * dl[j]
                    - 2. * nu * l / x.outer_length.powi(2) * outer;
                depsilon[j] += 1.5 * root * (0.19 / l + 0.51 / x.outer_length) * dk
                    - 0.19 * x.k * root / l.powi(2) * dl[j]
                    - 0.51 * x.k * root / x.outer_length.powi(2) * outer;
                dreynolds[j] = root / molecular_nu * dl[j]
                    + l / (2. * root * molecular_nu) * dk
                    - reynolds / molecular_nu * dmolecular[j];
            }
        }
        // Harmonic competition of turnover and molecular diffusion times.
        // Cancel the stable l~sqrt(k) law BEFORE this damping; do not form l²*k
        // and divide tiny powers. High-Re recovers the original eddy rates.
        if !reynolds.is_finite() || reynolds < 0. {
            return Err("Nonfinite local mixing Reynolds number");
        }
        let damping = reynolds / (1. + reynolds);
        let undamped_nu = nu;
        let undamped_kappa = kappa;
        for j in 0..INPUTS {
            let ddamping = dreynolds[j] / (1. + reynolds).powi(2);
            dnu[j] = dnu[j] * damping + undamped_nu * ddamping;
            dkappa[j] = dkappa[j] * damping + undamped_kappa * ddamping;
        }
        nu *= damping;
        kappa *= damping;
        status = if tie { LENGTH_TIE } else { INTERIOR };
        available = !tie;
    } else if x.k < 0. {
        // Signed numerical extension: root-dependent coefficients vanish, but
        // every linear signed isotropic stress AND its Q work remain below.
        status = SIGNED_TRIAL;
        available = true;
    } else if x.wall_distance == 0. {
        status = SOLID_ZERO;
        available = false;
    } else if n2 > 0. {
        // l~sqrt(k) cancels the apparent sqrt singularity for this right limit.
        // Damping adds another O(k); stable nu/kappa now have zero right slope.
        depsilon[K] += 0.19 / 0.76 * n2.sqrt();
        status = STABLE_ZERO_RIGHT;
        available = true;
    } else {
        let l = x.outer_length.min(0.7 * x.wall_distance);
        dnu[K] = 0.10 * l * l / molecular_nu;
        dkappa[K] = (1. + 2. * l / x.outer_length) * dnu[K];
        status = ZERO_RIGHT;
        // Physical right limit only; signed-trial left slope differs. At N²=0
        // no global jointly differentiable constitutive chart is claimed.
        available = true;
    }
    let buoyancy = -kappa / rho * contrast * x.pressure_gradient;
    let production = 4. / 3. * rho * nu * d * d - 2. / 3. * rho * x.k * theta;
    let axial = 4. / 3. * (x.viscosity + rho * nu) * d - 2. / 3. * rho * x.k;
    let transverse = -2. / 3. * (x.viscosity + rho * nu) * d - 2. / 3. * rho * x.k;
    let rates = [
        nu,
        kappa,
        epsilon,
        buoyancy,
        production,
        axial,
        transverse,
        production + buoyancy - rho * epsilon,
    ];
    if !rates.iter().all(|v| v.is_finite()) {
        return Err("Nonfinite selected mixing rate");
    }
    let mut derivatives = [[f64::NAN; INPUTS]; OUTPUTS];
    if available {
        for j in 0..INPUTS {
            let drho = if j == DENSITY { 1. } else { 0. };
            let dmu = if j == VISCOSITY { 1. } else { 0. };
            let dk = if j == K { 1. } else { 0. };
            let dd = if j == AXIAL_STRAIN {
                1.
            } else if j == TRANSVERSE_STRAIN {
                -1.
            } else {
                0.
            };
            let dt = if j == AXIAL_STRAIN {
                1.
            } else if j == TRANSVERSE_STRAIN {
                2.
            } else {
                0.
            };
            let dp = if j == PRESSURE_GRADIENT { 1. } else { 0. };
            let dc = if j == DENSITY_GRADIENT {
                1.
            } else if j == PRESSURE_GRADIENT {
                -1. / x.sound_squared
            } else if j == SOUND_SQUARED {
                x.pressure_gradient / x.sound_squared.powi(2)
            } else {
                0.
            };
            let dg = -dkappa[j] / rho * contrast * x.pressure_gradient
                + kappa / rho.powi(2) * drho * contrast * x.pressure_gradient
                - kappa / rho * (dc * x.pressure_gradient + contrast * dp);
            let dv = drho * nu + rho * dnu[j];
            let di = -2. / 3. * (drho * x.k + rho * dk);
            let prod = 4. / 3. * (dv * d * d + 2. * rho * nu * d * dd) + di * theta
                - 2. / 3. * rho * x.k * dt;
            let rows = [
                dnu[j],
                dkappa[j],
                depsilon[j],
                dg,
                prod,
                4. / 3. * ((dmu + dv) * d + (x.viscosity + rho * nu) * dd) + di,
                -2. / 3. * ((dmu + dv) * d + (x.viscosity + rho * nu) * dd) + di,
                prod + dg - drho * epsilon - rho * depsilon[j],
            ];
            for i in 0..OUTPUTS {
                derivatives[i][j] = rows[i];
            }
        }
        if !derivatives.iter().flatten().all(|v| v.is_finite()) {
            return Err("Nonfinite declared local mixing derivative");
        }
    }
    Ok(Output {
        rates,
        derivatives,
        derivative_status: status,
        derivatives_available: available as u32,
    })
}

/// Thin synchronous ABI for the existing offline C++ residual. No retained
/// pointers/allocation. Caller supplies valid, disjoint, aligned owned buffers.
/// On error the partial output is NOT an admitted result.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn leitbild_mixing_batch(
    input: *const Input,
    output: *mut Output,
    count: usize,
    numerical_trial: u32,
    failed: *mut usize,
    error: *mut u8,
    capacity: usize,
) -> i32 {
    let report = |message: &'static str, index: usize| {
        if !failed.is_null() {
            unsafe {
                *failed = index;
            }
        }
        if !error.is_null() && capacity > 0 {
            let length = message.len().min(capacity - 1);
            unsafe {
                std::ptr::copy_nonoverlapping(message.as_ptr(), error, length);
                *error.add(length) = 0;
            }
        }
        1
    };
    if numerical_trial > 1
        || (count > 0 && (input.is_null() || output.is_null()))
        || !(input as usize).is_multiple_of(align_of::<Input>())
        || !(output as usize).is_multiple_of(align_of::<Output>())
    {
        return report("Invalid mixing ABI role/buffer", 0);
    }
    let Some(input_bytes) = count.checked_mul(size_of::<Input>()) else {
        return report("Mixing ABI count overflow", 0);
    };
    let Some(output_bytes) = count.checked_mul(size_of::<Output>()) else {
        return report("Mixing ABI count overflow", 0);
    };
    let Some(input_end) = (input as usize).checked_add(input_bytes) else {
        return report("Mixing ABI buffer overflow", 0);
    };
    let Some(output_end) = (output as usize).checked_add(output_bytes) else {
        return report("Mixing ABI buffer overflow", 0);
    };
    if count > 0 && (input as usize) < output_end && (output as usize) < input_end {
        return report("Overlapping mixing ABI buffers", 0);
    }
    for i in 0..count {
        // SAFETY: documented caller-owned leases, checked alignment/size arithmetic;
        // each POD read is copied before a disjoint POD result is written.
        let x = unsafe { *input.add(i) };
        match evaluate(x, numerical_trial == 1) {
            Ok(value) => unsafe {
                *output.add(i) = value;
            },
            Err(message) => return report(message, i),
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(n2: f64, k: f64) -> Input {
        let rho = 990.;
        let dp = -rho * GRAVITY;
        let c2 = 2e6;
        Input {
            density: rho,
            viscosity: 6e-4,
            k,
            sound_squared: c2,
            pressure_gradient: dp,
            density_gradient: dp / c2 - n2 * rho / GRAVITY,
            axial_strain: 1.2,
            transverse_strain: -0.3,
            wall_distance: 0.5,
            outer_length: 0.06153846153846154,
            viscous_length: 0.04,
        }
    }
    fn close(a: f64, b: f64) {
        assert!(
            (a - b).abs() <= 1e-10 + 1e-10 * a.abs().max(b.abs()),
            "{a} != {b}"
        );
    }

    #[test]
    fn hydrostatic_buoyancy_has_one_density_factor() {
        for n2 in [-0.2, 0., 0.2] {
            let x = input(n2, 1e-4);
            let y = evaluate(x, false).unwrap();
            close(y.rates[3], -x.density * y.rates[1] * n2);
            let mut twice = x;
            twice.density *= 2.;
            twice.viscosity *= 2.; // Preserve kinematic viscosity in this identity.
            twice.pressure_gradient *= 2.;
            twice.density_gradient *= 2.;
            close(evaluate(twice, false).unwrap().rates[3], 2. * y.rates[3]);
        }
    }

    #[test]
    fn signed_trial_keeps_isotropic_stress_work_but_is_not_accepted() {
        let x = input(-0.2, -1e-4);
        assert!(evaluate(x, false).is_err());
        let y = evaluate(x, true).unwrap();
        assert_eq!(y.derivative_status, SIGNED_TRIAL);
        for j in [0, 1, 3] { assert_eq!(y.rates[j], 0.); }
        close(y.rates[2], 2. * x.viscosity / x.density * x.k / x.viscous_length.powi(2));
        let molecular = 4. / 3. * x.viscosity * (x.axial_strain - x.transverse_strain);
        let work = (y.rates[5] - molecular) * x.axial_strain
            + 2. * (y.rates[6] + molecular / 2.) * x.transverse_strain;
        close(y.rates[4], work);
        close(y.rates[7], work - x.density * y.rates[2]);
        close(
            y.derivatives[4][K],
            -2. / 3. * x.density * (x.axial_strain + 2. * x.transverse_strain),
        );
    }

    #[test]
    fn stable_zero_reports_finite_physical_right_limit_only() {
        let x = input(0.2, 0.);
        let zero = evaluate(x, false).unwrap();
        assert_eq!(zero.derivative_status, STABLE_ZERO_RIGHT);
        assert_eq!(zero.derivatives_available, 1);
        for i in [0, 1, 2, 3, 4, 7] {
            assert_eq!(zero.rates[i], 0.);
        }
        // Independently reconstruct the finite stable law, including molecular
        // competition. The zero derivative does not mean a finite ν is zero.
        let mut finite = x;
        finite.k = 1e-8;
        let positive = evaluate(finite, false).unwrap();
        let n2 =
            -GRAVITY / x.density * (x.density_gradient - x.pressure_gradient / x.sound_squared);
        let l = 0.76 * (finite.k / n2).sqrt();
        let num = finite.viscosity / finite.density;
        let nu = 0.10 * l * l * finite.k / (num + l * finite.k.sqrt());
        let kappa = (1. + 2. * l / x.outer_length) * nu;
        let higher_epsilon = 0.51 * finite.k * finite.k.sqrt() / x.outer_length;
        close(positive.rates[0] / nu, 1.);
        close(positive.rates[1] / kappa, 1.);
        close(positive.rates[2], zero.derivatives[2][K] * finite.k + higher_epsilon);
        close(positive.rates[3], -x.density * n2 * kappa);
        assert_eq!(zero.derivatives[0][K], 0.);
        assert_eq!(zero.derivatives[1][K], 0.);
    }

    #[test]
    fn stable_tiny_positive_energy_keeps_its_linear_rates() {
        let x = input(0.2, 1e-240);
        let y = evaluate(x, false).unwrap();
        let n2 =
            -GRAVITY / x.density * (x.density_gradient - x.pressure_gradient / x.sound_squared);
        // O(k²) ν may underflow honestly; the actual linear decay must survive.
        assert_eq!(y.rates[0], 0.);
        assert!(y.rates[2] > 0.);
        close(y.rates[2] / (((0.19 / 0.76) * n2.sqrt()
            + 2. * x.viscosity / x.density / x.viscous_length.powi(2)) * x.k), 1.);
        assert!(y.derivatives.iter().flatten().all(|v| v.is_finite()));
    }

    #[test]
    fn neutral_unstable_zero_have_finite_right_limits_and_ties_stay_honest() {
        for n2 in [0., -0.2] {
            let x = input(n2, 0.);
            let y = evaluate(x, false).unwrap();
            assert_eq!(y.derivative_status, ZERO_RIGHT);
            assert_eq!(y.derivatives_available, 1);
            close(y.derivatives[0][K], 0.10 * x.outer_length.powi(2) * x.density / x.viscosity);
            close(y.derivatives[2][K], 2. * x.viscosity / x.density / x.viscous_length.powi(2));
            let mut finite = x;
            finite.k = (1e-5 * (x.viscosity / x.density) / x.outer_length).powi(2);
            let right = evaluate(finite, false).unwrap();
            // Ratio, not a large absolute allowance that admits a wrong zero.
            close(right.rates[0] / (y.derivatives[0][K] * finite.k), 1. / (1. + 1e-5));
        }
        let mut x = input(0., 1e-4);
        x.wall_distance = 0.1;
        x.outer_length = 0.7 * x.wall_distance;
        let y = evaluate(x, false).unwrap();
        assert_eq!(y.derivative_status, LENGTH_TIE);
        assert_eq!(y.derivatives_available, 0);
    }

    #[test]
    fn low_and_high_re_limits_and_molecular_decay_are_independent() {
        for re in [1e-5_f64, 1e5] {
            let mut x = input(-0.2, 0.);
            let num = x.viscosity / x.density;
            x.k = (re * num / x.outer_length).powi(2);
            let y = evaluate(x, false).unwrap();
            let old = 0.10 * x.outer_length * x.k.sqrt();
            close(y.rates[0] / old, re / (1. + re));
            close(y.rates[0] / (0.10 * x.outer_length.powi(2) * x.k / num), 1. / (1. + re));
            let eps_eddy = 0.70 / x.outer_length * x.k * x.k.sqrt();
            close(y.rates[2], eps_eddy + 2. * num * x.k / x.viscous_length.powi(2));
        }
    }

    #[test]
    fn solid_zero_has_no_positive_energy_continuation() {
        let mut x = input(0., 0.);
        x.wall_distance = 0.;
        assert_eq!(evaluate(x, false).unwrap().derivative_status, SOLID_ZERO);
        x.k = 1e-10;
        assert!(evaluate(x, false).is_err());
    }

    #[test]
    fn paired_entropy_uses_actual_buoyancy_work() {
        let rho = 990.;
        let t = 313.15;
        let alpha = 4e-4;
        let cp = 4200.;
        for ds in [-100., 0., 100.] {
            let mut x = input(0., 1e-4);
            x.density_gradient = x.pressure_gradient / x.sound_squared - rho * alpha * t / cp * ds;
            let y = evaluate(x, false).unwrap();
            let qh = -rho * y.rates[1] * t * ds;
            let dt = t / cp * (ds + alpha / rho * x.pressure_gradient);
            let entropy = -y.rates[3] / t - qh * dt / (t * t);
            close(entropy, rho * y.rates[1] * ds * ds / cp);
            assert!(entropy >= -1e-12);
        }
    }

    #[test]
    fn pointwise_zero_does_not_select_an_unforced_implicit_root() {
        let l: f64 = 0.06153846153846154;
        let c = (0.19 + 0.51) / l;
        let h = 0.01;
        let x = input(0., 0.);
        let num = x.viscosity / x.density;
        let decay = 2. * num / x.viscous_length.powi(2);
        let b = (1. / h + decay) * l + c * num;
        let constant = (1. / h + decay) * num - 0.30 * l * l;
        let root = -2. * constant / (b + (b * b - 4. * c * l * constant).sqrt());
        let k = root * root;
        assert!(k > 0.);
        let mut actual = input(0., k);
        actual.axial_strain = 1.;
        actual.transverse_strain = -0.5;
        close(
            k - h * evaluate(actual, false).unwrap().rates[7] / actual.density,
            0.,
        );
        // Locally Lipschitz IVP has a unique zero solution; a sufficiently large
        // implicit step can STILL have another root. This is not a permission policy.
        actual.k = 0.;
        assert_eq!(evaluate(actual, false).unwrap().rates[7], 0.);
    }

    #[test]
    fn abi_rejects_unknown_roles_and_overlapping_buffers() {
        let x = input(0., 1e-4);
        let mut out = Output {
            rates: [0.; OUTPUTS],
            derivatives: [[0.; INPUTS]; OUTPUTS],
            derivative_status: 0,
            derivatives_available: 0,
        };
        let mut failed = usize::MAX;
        let mut text = [0u8; 128];
        unsafe {
            assert_eq!(
                leitbild_mixing_batch(
                    &x,
                    &mut out,
                    1,
                    2,
                    &mut failed,
                    text.as_mut_ptr(),
                    text.len()
                ),
                1
            );
            assert_eq!(failed, 0);
            assert_eq!(
                leitbild_mixing_batch(
                    &x,
                    &mut out,
                    1,
                    0,
                    &mut failed,
                    text.as_mut_ptr(),
                    text.len()
                ),
                0
            );
            let pointer = &mut out as *mut Output;
            assert_eq!(
                leitbild_mixing_batch(
                    pointer.cast::<Input>(),
                    pointer,
                    1,
                    0,
                    &mut failed,
                    text.as_mut_ptr(),
                    text.len()
                ),
                1
            );
        }
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! CRED-FIX-A2 (S6 rating, NOT EVIDENCE): the SG valve rating restated at
//! the relief's opening pressure with the runtime law. Each valve's
//! effective area is fixed by its rating, `A = m_rating / G(p_rating)`, with
//! `G` the equilibrium-nozzle flux of saturated vapor at `p` against the
//! atmospheric receiver (the SG owner's `derive`). The same area at another
//! inlet passes `A G(p)`, so a rating of `f` of nominal at 7.0 MPa is the
//! same valve as `f G(p)/G(7.0 MPa)` of nominal at `p`. Prints both fluxes
//! and the restated fraction.
use leitbild_operating_plant::{
    network::stratified,
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::If97;

fn flux(p: f64) -> (f64, f64, bool) {
    let sat = WaterProperties::saturation(&If97, Scalar::constant(p)).expect("saturation");
    let f = stratified::restriction_flux(
        &If97,
        true,
        Scalar::constant(p),
        Scalar::constant(sat.vapor.enthalpy.value),
        Scalar::constant(101_325.),
    )
    .expect("flux");
    (f.mass_flux.value, f.throat_pressure_pa.value, f.choked)
}

#[test]
#[ignore = "derivation helper for the wiki (CRED-FIX-A2): prints the restated SG valve rating"]
fn the_sg_valve_rating_restated_at_the_relief_opening_pressure() {
    let (old_p, new_p, old_fraction) = (7.0e6, 7_947_559., 0.6);
    let (g_old, t_old, c_old) = flux(old_p);
    let (g_new, t_new, c_new) = flux(new_p);
    assert!(c_old && c_new, "both ratings choked");
    let fraction = old_fraction * g_new / g_old;
    println!(
        "{}",
        serde_json::json!({"G_7.0MPa_kg_m2_s": g_old, "throat_7.0MPa_Pa": t_old,
            "G_7.947559MPa_kg_m2_s": g_new, "throat_7.947559MPa_Pa": t_new,
            "ratio": g_new / g_old, "restated_fraction": fraction,
            "restated_mass_flow_kg_s": fraction * 819.818983})
    );
}

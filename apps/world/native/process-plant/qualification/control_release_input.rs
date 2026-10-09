//! Strict consumed 698-word physical frame from controlReleasePhysicalInput.
use super::geometry_input::Reader;
use leitbild_plant_numerics::{control_release as cr,control_armature as ca,
    control_release_hydraulics as rh};

pub fn read(r:&mut Reader<'_>)->Result<cr::Input,String> {
    let clusters=r.count()?;
    if clusters!=52 {return Err("Cold release requires the actual 52-cluster frame".into());}
    let lift_m=r.number()?;let minimum_stem_m=r.number()?;
    let armature=ca::Config {mass_kg:r.number()?,stroke_m:r.number()?,spring_n_m:r.number()?,damping_n_s_m:r.number()?};
    let maximum_density_departure=r.number()?;let moving_impact_share=r.number()?;
    let jacks=cr::Receiver {targets:(0..4).map(|_|r.count()).collect::<Result<_,_>>()?,
        volume_m3:r.number()?,mass_kg:r.number()?,initial_k:300.};
    let mut contacts=Vec::with_capacity(clusters);
    for _ in 0..clusters {
        let fitting=cr::Receiver {targets:vec![r.count()?],volume_m3:r.number()?,mass_kg:r.number()?,initial_k:r.number()?};
        let collar_targets=(0..4).map(|_|r.count()).collect::<Result<_,_>>()?;
        let collar_volume=r.number()?;let collar_mass=r.number()?;
        let collar_stock_fraction=r.number()?;let collar_slice_mass_kg=r.number()?;let initial_k=r.number()?;
        contacts.push(cr::Contact {fitting,collar:cr::Receiver {targets:collar_targets,
            volume_m3:collar_volume,mass_kg:collar_mass,initial_k},collar_stock_fraction,collar_slice_mass_kg});
    }
    let shoulder=rh::Shoulder {radius_m:r.number()?,bottom_m:r.number()?,top_m:r.number()?};
    let broad=rh::BroadSelection {body_area_m2:r.number()?,stem_area_m2:r.number()?,coefficient:r.number()?};
    let normal_stop=match r.count()? {0=>cr::NormalStopPolicy::AbruptBrake,
        1=>cr::NormalStopPolicy::BackdrivableCoastToHold,_=>return Err("Unknown physical normal-stop selection".into())};
    Ok(cr::Input {lift_m,minimum_stem_m,armature,maximum_density_departure,moving_impact_share,jacks,contacts,shoulder,broad,normal_stop})
}

/** Offline constitutive selection for the single-ended PRHR return. No runtime or profile solver. */
import {z} from 'zod'
import {darcyFriction} from './reference-design-prhr-geometry'

const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative()
const basisSchema=z.object({diameter_m:positive,length_m:positive,rise_m:z.number().finite(),roughness_m:nonnegative,
  initialCoreFraction:z.number().finite().gt(0).lt(1),mixingCoefficient:nonnegative,turbulentPrandtl:positive,entranceCoefficient:nonnegative}).strict()
  .refine(b=>Math.abs(b.rise_m)<=b.length_m&&b.roughness_m<b.diameter_m*(1-b.initialCoreFraction),'Realizable route and roughness required')
export type PrhrExchangeBasis=z.infer<typeof basisSchema>
export type ExchangeWater={temperature_K:number;density_kg_m3:number;viscosity_Pas:number;conductivity_W_mK:number;cp_J_kgK:number}
const waterSchema=z.object({temperature_K:positive,density_kg_m3:positive,viscosity_Pas:positive,conductivity_W_mK:positive,cp_J_kgK:positive}).strict()
const harmonic=(a:number,b:number)=>2*a*b/(a+b)

/** Original tee-scale spatial envelope; integrates to one, not a measured penetration distance. */
export function prhrEntranceWeight(position_m:number,length_m:number,diameter_m:number):number {
  if(![position_m,length_m,diameter_m].every(Number.isFinite)||length_m<=0||diameter_m<=0||position_m<0||position_m>length_m)throw Error('Position must lie on the positive-length return')
  return Math.exp(-position_m/diameter_m)/(diameter_m*-Math.expm1(-length_m/diameter_m))
}

export function parsePrhrExchange(text:string):PrhrExchangeBasis {
  const blocks=[...text.matchAll(/^```reference-prhr-exchange\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one PRHR exchange selection required')
  return basisSchema.parse(JSON.parse(blocks[0]![1]!))
}

/** Positive axial velocities point from SG to bank; core/annulus are computational regions, not a divider. */
export function prhrExchange(raw:PrhrExchangeBasis,core:ExchangeWater,annulus:ExchangeWater,coreFraction:number,uc:number,ua:number,mainVelocity:number,mainDensity:number) {
  const b=basisSchema.parse(raw),c=waterSchema.parse(core),a=waterSchema.parse(annulus)
  if(![coreFraction,uc,ua,mainVelocity,mainDensity].every(Number.isFinite)||mainDensity<=0||coreFraction<=0||coreFraction>=1||b.roughness_m>=b.diameter_m*(1-coreFraction))throw Error('Admitted local fraction, finite velocities and positive main density required')
  const area=Math.PI*b.diameter_m**2/4,Ac=coreFraction*area,Aa=area-Ac
  const Pi=Math.PI*b.diameter_m*Math.sqrt(coreFraction),Pw=Math.PI*b.diameter_m
  const ell=4*Ac*Aa/(Pi*area),slip=uc-ua,rho=(c.density_kg_m3+a.density_kg_m3)/2,cp=(c.cp_J_kgK+a.cp_J_kgK)/2
  const viscosity=harmonic(c.viscosity_Pas,a.viscosity_Pas)+rho*b.mixingCoefficient*ell*Math.abs(slip)
  const shear=viscosity*slip/ell,force=shear*Pi*b.length_m
  const h=harmonic(c.conductivity_W_mK,a.conductivity_W_mK)/ell+rho*cp*b.mixingCoefficient*Math.abs(slip)/b.turbulentPrandtl
  const heat=h*Pi*b.length_m*(c.temperature_K-a.temperature_K),dissipation=force*slip
  // Interface shear is already owned above; only the physical outside perimeter owns pipe-wall drag.
  const wallDh=4*Aa/Pw,re=a.density_kg_m3*Math.abs(ua)*wallDh/a.viscosity_Pas
  const wallDrop=ua===0?0:darcyFriction(re,b.roughness_m/wallDh)*b.length_m/wallDh*a.density_kg_m3*ua*Math.abs(ua)/2
  const wallForce=-wallDrop*Aa,wallDissipation=-wallForce*ua
  // Symmetric tee stirring preference is core toward bank for either main-flow direction.
  // This is signed mechanical exchange, not an imposed heat source or a nonnegative duty.
  const effectiveArea=1/(1/Ac+1/Aa),entranceHead=b.entranceCoefficient*mainDensity*mainVelocity**2/2
  const entranceForce=entranceHead*effectiveArea,entranceWork=entranceForce*slip
  const mainReactionForce=-b.entranceCoefficient*mainDensity*mainVelocity*effectiveArea*slip/2
  const coreHeat=-heat+dissipation/2,annulusHeat=heat+dissipation/2+wallDissipation
  return {geometry:{area_m2:area,coreArea_m2:Ac,annulusArea_m2:Aa,interfacePerimeter_m:Pi,wallPerimeter_m:Pw,mixingLength_m:ell,wallHydraulicDiameter_m:wallDh},
    shear_Pa:shear,interstreamConductance_W_K:h*Pi*b.length_m,
    coreForce_N:-force+entranceForce,annulusForce_N:force-entranceForce+wallForce,
    coreHeat_W:coreHeat,annulusHeat_W:annulusHeat,interstreamHeat_W:heat,
    interfacialDissipation_W:dissipation,wallDissipation_W:wallDissipation,
    entranceHead_Pa:entranceHead,entranceRelativeDisplacement_m3_s:effectiveArea*slip,entranceWork_W:entranceWork,mainReactionForce_N:mainReactionForce,
    mechanicalAndHeatResidual_W:(-force+entranceForce)*uc+(force-entranceForce+wallForce)*ua+coreHeat+annulusHeat+mainReactionForce*mainVelocity,
    entropyProduction_W_K:heat*(1/a.temperature_K-1/c.temperature_K)+dissipation/2*(1/a.temperature_K+1/c.temperature_K)+wallDissipation/a.temperature_K,
    // The common pressure-gradient force cancels in this difference; acceleration is not discarded.
    differentialDrivingGradient_Pa_m:(a.density_kg_m3-c.density_kg_m3)*9.80665*b.rise_m/b.length_m,
    differentialDragGradient_Pa_m:force/b.length_m*(1/Ac+1/Aa)+wallForce/(Aa*b.length_m),
    entranceDifferentialGradient_Pa_m:entranceHead/b.length_m}
}

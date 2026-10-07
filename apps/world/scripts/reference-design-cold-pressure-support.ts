/** One authored cold pressure-support reduction, compiled from existing physical geometry.
 * Native preparation derives gas inventory from the actual primary boundary.
 * Compilation is not an advancing trajectory or an installed plant. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {heaterBankBasis,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'
import {shellContactGeometry} from './reference-design-pressurizer-shell-contact'
import {parseSurgeRoute,resolveSurgeRoute} from './reference-design-surge-route'

const positive=z.number().finite().positive(),finite=z.number().finite()
const schema=z.object({primaryCell:z.string().min(1),initialLevel_m:positive,initialTemperature_K:positive,
 minimumLevel_m:positive,maximumLevel_m:positive,minimumTemperature_K:positive,maximumTemperature_K:positive,
 maximumTotalPressure_Pa:positive,maximumVaporPressure_Pa:positive,nitrogenMass_kg:finite.nonnegative(),
 interfaceLength_m:positive,diffusivityReference_m2_s:positive,diffusivityReferenceTemperature_K:positive,
 diffusivityReferencePressure_Pa:positive,diffusivityExponent:finite,gasConductivity_W_m_K:positive,
 wetContact_W_m2_K:positive,gasContact_W_m2_K:positive,wallCondensationSpeed_m_s:finite.nonnegative(),
 ambientTemperature_K:positive,insulationThickness_m:positive,insulationConductivity_W_m_K:positive,
 exteriorContact_W_m2_K:positive}).strict().superRefine((s,c)=>{
 if(!(s.minimumLevel_m<s.initialLevel_m&&s.initialLevel_m<s.maximumLevel_m
  &&s.minimumTemperature_K<s.initialTemperature_K&&s.initialTemperature_K<s.maximumTemperature_K
  &&s.minimumTemperature_K<=s.ambientTemperature_K&&s.ambientTemperature_K<=s.maximumTemperature_K))
  c.addIssue({code:'custom',message:'Cold preparation is outside the selected envelope'})
})
export function parseColdPressureSelection(text:string){return schema.parse(configurationBlock(text,'reference-cold-pressure-support'))}
type Water={id:string;elevation_m:number}
type Caloric={cp0_j_kg_k:number;cp1_j_kg_k2:number;datum_k:number;minimum_k:number;maximum_k:number}
export function compileColdPressure(selectionText:string,routeText:string,water:Water[],caloric:Caloric,atomsPerMarker:number){
 const s=parseColdPressureSelection(selectionText),r=resolveSurgeRoute(parseSurgeRoute(routeText)),
  primary=water.findIndex(w=>w.id===s.primaryCell),b=heaterBankBasis,
  rods=heaterBankGeometry(s.initialLevel_m).banks,g=shellContactGeometry()
 if(primary<0||water[primary]!.elevation_m!==r.sourceElevation_m||r.receiverElevation_m!==b.bottom_m
  ||s.minimumLevel_m<Math.max(b.normal.length_m,b.backup.length_m)||s.maximumLevel_m>=b.vesselHeight_m
  ||!Number.isFinite(atomsPerMarker)||atomsPerMarker<=0)throw Error('Cold pressure geometry/material join differs from actual owners')
 // Contact geometry is wet/dry; exterior insulation uses gross external area.
 // Two original patches become ONE finite owner per whole head explicitly.
 const ga=(area:number)=>area/(s.insulationThickness_m/s.insulationConductivity_W_m_K+1/s.exteriorContact_W_m2_K)
 const metals=[
  ...(['normal','backup'] as const).map(name=>({mass:rods[name].steelMass_kg,kind:'rod' as const,bottom:0,
   top:b[name].length_m,area:rods[name].fullSideArea_m2,ambient:0})),
  ...g.shell.map(q=>({mass:q.steelMass_kg,kind:'shell' as const,bottom:q.bottom_m,top:q.top_m,area:q.area_m2,ambient:ga(q.area_m2)})),
  ...(['bottom','top'] as const).map(name=>{const h=g.heads.filter(q=>q.name===name)
   return {mass:h.reduce((v,q)=>v+q.steelMass_kg,0),kind:name,bottom:0,top:0,
    area:h.reduce((v,q)=>v+q.area_m2,0),ambient:ga(h.reduce((v,q)=>v+q.grossSolidArea_m2,0))}}),
 ]
 // Finite solid-to-solid radiation is omitted in this low-temperature slice;
 // there is no invented radiation sink into a transparent gas.
 const outsideRadius=r.internalDiameter_m/2+r.wallThickness_m,
  insulatedRadius=outsideRadius+s.insulationThickness_m,
  lineAmbientConductance=1/(Math.log(insulatedRadius/outsideRadius)/(2*Math.PI*s.insulationConductivity_W_m_K*r.developedLength_m)
   +1/(s.exteriorContact_W_m2_K*2*Math.PI*insulatedRadius*r.developedLength_m))
 // Coefficient validity is not operating applicability. The whole selected
 // cold interval, not just its initial point, must fit the steel caloric law.
 if(!(caloric.minimum_k<=s.minimumTemperature_K&&s.maximumTemperature_K<=caloric.maximum_k)
  ||!Number.isFinite(lineAmbientConductance)||lineAmbientConductance<=0)
  throw Error('Cold pressure caloric/contact preparation is outside its owned domain')
 return {selection:s,primary,metals,route:r,caloric,atomsPerMarker,lineAmbientConductance,
  scope:'Fresh positive cold pool/cushion and finite surge only; no hot pressure control, resolved fronts, dryout or whole-plant qualification'}
}

/** Sixth exact native frame. Fixed physical populations are not padded with
 * unused fields; each contact tag carries only its actual owned geometry. */
export function nativeColdPressureFrame(p:ReturnType<typeof compileColdPressure>){
 const {selection:s,route:r,caloric:c}=p,b=heaterBankBasis,
  rods=heaterBankGeometry(s.initialLevel_m).banks,
  fields=[p.primary,
   r.liquidVolume_m3,r.volumeMeanElevation_m,r.developedLength_m,r.internalDiameter_m,r.roughness_m,
   // Sound-filtered resistance-node convention: actual route entry + discharge
   // minor resistance is charged once on the incoming half. No KE flux/heater.
   r.entryLoss+r.exitLoss,r.elbowLoss,r.steelMass_kg,c.cp0_j_kg_k,c.cp1_j_kg_k2,c.datum_k,
   s.minimumTemperature_K,s.maximumTemperature_K,s.wetContact_W_m2_K*r.innerContactArea_m2,
   p.lineAmbientConductance,s.ambientTemperature_K,
   b.vesselArea_m2,b.vesselHeight_m,b.bottom_m,
   rods.normal.crossSection_m2,b.normal.length_m,rods.backup.crossSection_m2,b.backup.length_m,
   s.minimumLevel_m,s.maximumLevel_m,s.minimumTemperature_K,s.maximumTemperature_K,
   s.maximumTotalPressure_Pa,s.maximumVaporPressure_Pa,s.nitrogenMass_kg,s.interfaceLength_m,
   s.diffusivityReference_m2_s,s.diffusivityReferenceTemperature_K,s.diffusivityReferencePressure_Pa,
   s.diffusivityExponent,s.gasConductivity_W_m_K,s.wetContact_W_m2_K,s.gasContact_W_m2_K,
   s.wallCondensationSpeed_m_s,c.cp0_j_kg_k,c.cp1_j_kg_k2,c.datum_k,s.minimumTemperature_K,s.maximumTemperature_K,s.ambientTemperature_K]
 for(const m of p.metals){
  fields.push(m.mass,m.ambient)
  if(m.kind==='rod')fields.push(0,m.top,m.area)
  else if(m.kind==='shell')fields.push(1,m.bottom,m.top,m.area)
  else fields.push(m.kind==='bottom'?2:3,m.area)
 }
 // Cold reduction omits solid radiation; no zero-stock radiation recipients.
 fields.push(0,s.initialTemperature_K,s.initialTemperature_K,s.initialLevel_m,
  ...p.metals.map(()=>s.initialTemperature_K),s.initialTemperature_K,s.initialTemperature_K)
 if(fields.some(v=>!Number.isFinite(v)))throw Error('Nonfinite cold pressure frame')
 return fields
}

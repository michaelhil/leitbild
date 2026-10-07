/** One authored cold pressure-support reduction, compiled from existing physical geometry.
 * Native preparation derives the actual gas inventory from the current primary
 * boundary in a future connected preparation. This compiler is currently
 * geometry/selection-only: no numeric wire frame or runtime is implied. */
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
type Caloric={cp0_j_kg_k:number;cp1_j_kg_k2:number;datum_k:number}
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
 return {selection:s,primary,metals,route:r,caloric,atomsPerMarker,
  scope:'Fresh positive cold pool/cushion and finite surge only; no hot pressure control, resolved fronts, dryout or whole-plant qualification'}
}

/** Actual ORIGINAL converter photon/contact projection. Rates only: this does
 * not create a new guide-water stock or advance apparatus thermal energies. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parsePassiveMaterialLaw} from './reference-design-source-passive'
import {nuclearObservationGeometry} from './reference-design-nuclear-observation'
import type {parseNuclearObservation} from './reference-design-nuclear-observation'
import type {parsePrimaryWaterInputs} from './reference-design-source-water'
import type {compileModeratorInputs} from './reference-design-source-moderator'
const positive=z.number().finite().positive(),pair=z.tuple([positive,positive])
export function parseCapturePhotonAbsorption(document:string){
 return z.object({energies_MeV:z.tuple([z.literal(.5),z.literal(1)]),mu_en_m2_kg:z.object({
  B:pair,C:pair,Fe:pair,Cr:pair,Ni:pair,Mn:pair,Zr:pair,H2O:pair,UO2:pair}).strict()}).strict()
  .parse(configurationBlock(document,'reference-capture-photon-absorption'))
}
export function compileConverterHeat(d:ReturnType<typeof parsePrimaryWaterInputs>,
 apparatus:ReturnType<typeof parseNuclearObservation>,moderator:ReturnType<typeof compileModeratorInputs>,
 sourceText:string,birthEmission_neutrons_s:number){
 const law=parsePassiveMaterialLaw(sourceText),photon=parseCapturePhotonAbsorption(sourceText),
  geo=nuclearObservationGeometry(apparatus,d.handling,{birthEmission_neutrons_s}),
  stocks=new Map(geo.stocks.map(s=>[s.id,s])),collectorMembers=['CARRIER','CONVERTER','RING.0','RING.1'],
  collectorVolume=collectorMembers.reduce((s,id)=>s+(stocks.get(id)?.volume_m3??NaN),0),
  helium=stocks.get('He.3'),wall=stocks.get('WALL.3'),
  rGuide=d.handling.guideInnerDiameter_m/2,rThimble=d.handling.sourceThimbleDiameter_m/2,
  length=d.fuel.activeLength_m/2,A=Math.PI*(rGuide*rGuide-rThimble*rThimble),
  V=A*length,boundary=2*Math.PI*(rGuide+rThimble)*length+2*A,
  indices=moderator.identities.rows.flatMap((id,i)=>id.startsWith('Core.2.GUIDE|')?[i]:[]),
  originalWaterMass=indices.reduce((s,i)=>s+moderator.stocks[i]!.water_mass,0),
  originalWaterVolume=indices.reduce((s,i)=>s+moderator.stocks[i]!.liquid_volume,0)
 if(!helium||!wall||![collectorVolume,helium.volume_m3,wall.volume_m3,A,V,boundary,originalWaterMass,originalWaterVolume]
  .every(q=>Number.isFinite(q)&&q>0)||apparatus.carrierCentre_m-apparatus.carrierLength_m/2<0
  ||apparatus.carrierCentre_m+apparatus.carrierLength_m/2>length||V>originalWaterVolume)
  throw Error('Unresolved ORIGINAL converter material/liquid contact')
 const boronMass=4*d.chemistry.isotope10MolarMass_kg_mol*d.chemistry.isotopeFraction
  +4*d.chemistry.isotope11MolarMass_kg_mol*(1-d.chemistry.isotopeFraction),
  boronShare=boronMass/(boronMass+.012011),
  filmMu=boronShare*photon.mu_en_m2_kg.B[0]+(1-boronShare)*photon.mu_en_m2_kg.C[0],
  steelMu=law.steel304.massFractions.reduce((s,f,i)=>s+f*photon.mu_en_m2_kg[law.steel304.elements[i] as 'Fe'|'Cr'|'Ni'|'Mn'][0],0)
 if(!(boronShare>0&&boronShare<1))throw Error('Unselected B4C elemental photon composition')
 return {geometry:{film_thickness:geo.geometry.filmThickness_m,film_density:law.B4C.density,film_mu_en:filmMu,
  carrier_wall:apparatus.carrierWall_m,thimble_wall:apparatus.wall_m,steel_density:law.steel304.density,steel_mu_en:steelMu},
  emission:law.boronEmission_J,liquid:{density:originalWaterMass/originalWaterVolume,mu_en:photon.mu_en_m2_kg.H2O[0],chord:4*V/boundary},
  recipients:{collector:{id:'COLLECTOR',members:collectorMembers,volume_m3:collectorVolume},helium:{id:helium.id,volume_m3:helium.volume_m3},
   wall:{id:wall.id,volume_m3:wall.volume_m3},liquid:{id:'Core.2.GUIDE',originalWaterMass_kg:originalWaterMass,originalWaterVolume_m3:originalWaterVolume,
    physicalContact:{z0_m:0,z1_m:length,innerRadius_m:rThimble,outerRadius_m:rGuide,volume_m3:V,boundary_m2:boundary}}},
  scope:'Selected ORIGINAL cold converter contact sub-envelope and finite named recipients; aggregate native liquid density, not local evolved state. Rates only. Explicit absent-liquid counterfactual exports post-wall remainder; unresolved contact refuses.'}
}

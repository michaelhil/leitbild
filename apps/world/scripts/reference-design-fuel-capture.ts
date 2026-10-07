/** Fixed-cold FUEL binding photons into existing finite fuel/clad/water.
 * This compiles physical geometry only; current capture rates and absorption
 * derivatives belong to the native owner, not a second TypeScript heat law. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'
import {parsePassiveMaterialLaw} from './reference-design-source-passive'
import type {compileColdSourceMaterialOwners} from './reference-design-source-material'
import type {compileFuelCoolingMaterial} from './reference-design-fuel-cooling'
import type {compileColdBarrel} from './reference-design-source-barrel'
import type {compileOperatingNetwork} from './reference-design-operating-network'

const positive=z.number().finite().positive()
const selectionSchema=z.object({capturePhoton_MeV:z.tuple([positive,positive,positive]),
 fuelPhotonBoundary:z.literal('full-active-column-side-and-two-ends'),
 fuelSelfAllocation:z.literal('actual-intersection-fuel-mass'),
 cladAllocation:z.literal('serial-physical-radial-control-volumes'),
 liquidEnvelope:z.literal('existing-half-core-external-water'),gapAbsorption:z.literal('uncredited')}).strict()
export function parseFuelCaptureSelection(document:string){
 return selectionSchema.parse(configurationBlock(document,'reference-fuel-capture-binding'))
}
type Material=ReturnType<typeof compileColdSourceMaterialOwners>
type Thermal=ReturnType<typeof compileFuelCoolingMaterial>
type Barrel=ReturnType<typeof compileColdBarrel>
type Network=Pick<Awaited<ReturnType<typeof compileOperatingNetwork>>,'water'>
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-15))
  throw Error('Fuel capture physical incidence differs: '+label)
}

export function compileFuelCapture(material:Material,thermal:Thermal,network:Network,barrel:Barrel,sourceText:string){
 const selection=parseFuelCaptureSelection(sourceText),photon=parseCapturePhotonAbsorption(sourceText),
  law=parsePassiveMaterialLaw(sourceText),f=material.input.fuel,
  radius=f.pelletDiameter_m/2,length=f.activeLength_m,
  hostVolume=Math.PI*radius**2*length,hostBoundary=2*Math.PI*radius*length+2*Math.PI*radius**2,
  fuelDensity=f.fuelDensityFraction*f.fuelTheoreticalDensity_kg_m3,
  cladInner=f.rodOuterDiameter_m/2-f.cladThickness_m,cladOuter=f.rodOuterDiameter_m/2
 if(![hostVolume,hostBoundary,fuelDensity,cladInner,cladOuter].every(q=>Number.isFinite(q)&&q>0)
  ||!(cladOuter>cladInner&&cladInner>radius)||thermal.bands.length===0)
  throw Error('Missing finite fuel capture geometry')
 close(law.guideZr.density,f.cladDensity_kg_m3,'Zr material density')
 const cohorts=new Map(material.result.cohorts.map(c=>[c.id,c])),used=new Set<string>()
 const bands=thermal.bands.map((b,index)=>{
  close(b.fuel_radius_m,radius,b.id+' fuel radius')
  close(b.clad_inner_radius_m,cladInner,b.id+' clad inner')
  close(b.clad_outer_radius_m,cladOuter,b.id+' clad outer')
  const own=b.cohortIds.map(id=>{
   const c=cohorts.get(id)
   if(!c||used.has(id))throw Error('Missing/duplicated fuel capture thermal owner '+id)
   used.add(id);return c
  }),fuel=own.filter(c=>c.material==='fuel'),clad=own.filter(c=>c.material==='clad')
  if(fuel.length===0||fuel.length!==b.fuel_masses_kg.length||clad.length!==3||b.clad_masses_kg.length!==3)
   throw Error('Incomplete fuel capture radial controls')
  let edge=cladInner
  const thickness=clad.map((c,i)=>{
   if(c.node!==i||!(c.outer_m>c.inner_m)||c.z0_m!==fuel[0]?.z0_m||c.z1_m!==fuel[0]?.z1_m)
    throw Error('Invalid fuel capture radial control '+c.id)
   close(c.inner_m,edge,c.id+' contiguous inner')
   close(c.referenceMass_kg,b.clad_masses_kg[i]!,c.id+' thermal mass')
   edge=c.outer_m;return c.outer_m-c.inner_m
  }) as [number,number,number]
  close(edge,cladOuter,b.id+' complete clad thickness')
  fuel.forEach((c,i)=>{
   if(c.node!==i)throw Error('Unordered fuel capture thermal owner '+c.id)
   close(c.referenceMass_kg,b.fuel_masses_kg[i]!,c.id+' thermal mass')
  })
  const lo=fuel[0]!.z0_m,hi=fuel[0]!.z1_m,
   cell=hi<=0?'CORE.1':lo>=0?'CORE.2':undefined,
   owner=cell==='CORE.1'?'Core.1.EXTERNAL':cell==='CORE.2'?'Core.2.EXTERNAL':undefined,
   contacts=barrel.contacts.filter(c=>c.owner===owner),water=network.water[b.water]
  close(b.length_m,hi-lo,b.id+' axial contact length')
  if(!cell||!water||water.id!==cell||contacts.length!==1||contacts[0]!.water_index!==b.water
   ||contacts[0]!.cellId!==cell||own.some(c=>c.z0_m!==lo||c.z1_m!==hi))
   throw Error('Unresolved actual fuel capture water recipient '+b.id)
  const contact=contacts[0]!
  if(![contact.photonVolume_m3,contact.photonBoundary_m2,contact.liquid_chord_m].every(q=>Number.isFinite(q)&&q>0)
   ||contact.photonVolume_m3>water.volume_m3*(1+4e-10))
   throw Error('Invalid fuel capture liquid envelope '+cell)
  close(contact.liquid_chord_m,4*contact.photonVolume_m3/contact.photonBoundary_m2,cell+' physical chord')
  return {band_index:index,water_index:b.water,water_id:cell,liquid_chord_m:contact.liquid_chord_m,
   clad_thickness_m:thickness}
 })
 if(used.size!==material.result.cohorts.length)throw Error('Unmapped fuel capture thermal owner')
 const emission=selection.capturePhoton_MeV.map(q=>q*1.602176634e-13) as [number,number,number]
 if(!emission.every(q=>Number.isFinite(q)&&q>0))throw Error('Unrepresentable fuel capture emission')
 return {selection,capture_photon_j:emission,fuel_chord_m:4*hostVolume/hostBoundary,
  fuel_density_kg_m3:fuelDensity,fuel_mu_en_m2_kg:photon.mu_en_m2_kg.UO2[1],
  clad_density_kg_m3:f.cladDensity_kg_m3,clad_mu_en_m2_kg:photon.mu_en_m2_kg.Zr[1],
  liquid_mu_en_m2_kg:photon.mu_en_m2_kg.H2O[1],hostVolume_m3:hostVolume,hostBoundary_m2:hostBoundary,bands,
  scope:'Fixed-cold fertile/Xe/Sm binding, actual intersection W into existing radial fuel/clad and current half-core external water; explicit export. Effective photon projection, no mobile-water or apparatus heat.'}
}
export function nativeFuelCaptureFrame(c:ReturnType<typeof compileFuelCapture>){
 return [...c.capture_photon_j,c.fuel_chord_m,c.fuel_density_kg_m3,c.fuel_mu_en_m2_kg,
  c.clad_density_kg_m3,c.clad_mu_en_m2_kg,c.liquid_mu_en_m2_kg,c.bands.length,
  ...c.bands.flatMap(b=>[b.band_index,b.water_index,b.liquid_chord_m,...b.clad_thickness_m])]
}

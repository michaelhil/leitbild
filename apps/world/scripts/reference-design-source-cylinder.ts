/** Actual ORIGINAL body/converter targets and incidence; no field advancement,
 * deposited-photon shortcut or detector calibration/acquired-state initializer. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parsePassiveMaterialLaw,type compileOriginalPassiveGeometry} from './reference-design-source-passive'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {circleRectangleArcs} from './reference-design-source-faces'
import type {compileSourcePartition} from './reference-design-source-partition'
import type {parsePrimaryWaterInputs} from './reference-design-source-water'
import type {compileColdSourceMaterial} from './reference-design-source-material'
import type {parseNuclearObservation} from './reference-design-nuclear-observation'

const positive=z.number().finite().positive(),responseSchema=z.object({escapeDepth_m:positive,collectionFraction:z.number().finite().min(0).max(1)}).strict()
export const parseConverterResponse=(doc:string)=>responseSchema.parse(configurationBlock(doc,'reference-converter-response'))
const sum=(xs:readonly number[])=>xs.reduce((s,x)=>s+x,0)
function near(a:number,b:number,label:string){
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(b),1e-30))throw Error('Cylinder geometry/stock coverage '+label)
}
type Input=ReturnType<typeof parsePrimaryWaterInputs>
type Target={id:string,atoms:number,products:number,reference_atoms:number,inner_radius:number,outer_radius:number,length:number,multiplicity:number,
 sigma:number[],escape_depth:number,collection:number,binding_emission:[number,number],thermalRecipientId:string}

export function compileCylinderInputs(partition:ReturnType<typeof compileSourcePartition>,d:Input,
 material:ReturnType<typeof compileColdSourceMaterial>,passive:ReturnType<typeof compileOriginalPassiveGeometry>,
 apparatus:ReturnType<typeof parseNuclearObservation>,sourceOwnerText:string){
 const law=parsePassiveMaterialLaw(sourceOwnerText),response=parseConverterResponse(sourceOwnerText),
  targets:Target[]=[],intersections:{target:number,region:number,share:number}[]=[],
  regions=new Map(partition.regions.map((r,i)=>[r.id,{r,i}])),
  c=d.control,h=d.handling,cg=controlAbsorberGeometry(c,d.fuel,h),bodyRadius=c.absorberDiameter_m/2,
  bodyArea=2*Math.PI*bodyRadius*c.activeLength_m*c.rodletsPerCluster,
  bodies=passive.stocks.filter(s=>s.captureMode==='cylinder')
 if(regions.size!==partition.regions.length||passive.regionVolumes.length!==partition.regions.length
  ||passive.regionVolumes.some((v,i)=>v!==partition.regions[i]!.volume_m3)||bodies.length!==c.clusters)
  throw Error('Cylinder/source immutable identity mismatch')
 for(const site of cg.sites){const id=`CONTROL/${site.x}/${site.y}/B4C`,s=bodies.find(s=>s.id===id)
  if(!s||s.material!=='B4C'||s.targets.length!==1||s.targets[0]!.id!==id+'/B10')throw Error('Missing immutable body B10 target')
  const t=s.targets[0]!,target=targets.length,V=Math.PI*bodyRadius**2*c.activeLength_m*c.rodletsPerCluster
  near(s.volume_m3,V,id);near(t.atoms,t.referenceAtoms,id+' original atoms')
  if(t.productAtoms!==0)throw Error('Cylinder original products are not zero')
  targets.push({id:t.id,atoms:t.atoms,products:t.productAtoms,reference_atoms:t.referenceAtoms,inner_radius:0,outer_radius:bodyRadius,
   length:c.activeLength_m,multiplicity:c.rodletsPerCluster,sigma:t.sigma_m2,escape_depth:0,collection:0,binding_emission:t.bindingEmission_J,thermalRecipientId:s.thermalRecipientId})
  const rows=passive.volumeMaterial.filter(e=>e.stockId===id)
  for(const e of rows){const own=regions.get(e.sourceRegionId)
   if(!own)throw Error('Unknown body source region')
   // In this ORIGINAL coarse plan each actual rodlet is laterally contained.
   // Verify, rather than assuming that a volume cut is a surface-current cut.
   if(own.r.box){const r=own.r,dz=Math.max(0,Math.min(c.insertedActiveBottom_m+c.activeLength_m,r.z1_m!)-Math.max(c.insertedActiveBottom_m,r.z0_m!)),
    lateral=sum(cg.bodySites.map(pin=>{
     const x=site.x_m+pin.x_m,y=site.y_m+pin.y_m,b=r.box!
     return bodyRadius*sum(circleRectangleArcs(bodyRadius,{x0:b.x0-x,x1:b.x1-x,y0:b.y0-y,y1:b.y1-y}).map(a=>a.hi-a.lo))*dz
    }))
    near(lateral/bodyArea,e.volume_m3/V,'ORIGINAL body volume/lateral share '+id+' '+r.id)
   }else if(own.r.id!=='LOWER'&&own.r.id!=='UPPER')throw Error('Unselected body equipment embedding')
   intersections.push({target,region:own.i,share:e.volume_m3/V})
  }
  near(sum(rows.map(r=>r.volume_m3)),V,'complete body '+id)
 }
 const ri=apparatus.carrierOD_m/2,L=apparatus.carrierLength_m,
  f10=4*h.b10AtomFraction*h.b10MolarMass_kg_mol/h.b4cMolarMass_kg_mol,
  ro=Math.sqrt(ri*ri+2*ri*apparatus.b10Areal_kg_m2/(h.b4cDensity_kg_m3*f10)),
  carrierArea=2*Math.PI*ri*L,outerArea=2*Math.PI*ro*L,M10=carrierArea*apparatus.b10Areal_kg_m2,
  atoms=M10*d.chemistry.avogadro_mol/h.b10MolarMass_kg_mol,converter=material.converter
 if(ro>=h.sourceThimbleDiameter_m/2-apparatus.wall_m||response.escapeDepth_m>ro-ri)throw Error('Converter film/escape does not fit actual annulus')
 near(converter.radius_m,ri,'carrier radius');near(converter.filmOuterRadius_m,ro,'outer film radius')
 near(converter.opticalArea_m2,carrierArea,'carrier incidence area');near(converter.b10Mass_kg,M10,'converter B10 mass')
 near(converter.z0_m,apparatus.carrierCentre_m-L/2,'converter lower');near(converter.z1_m,apparatus.carrierCentre_m+L/2,'converter upper')
 const target=targets.length
 targets.push({id:'CONVERTER/B10',atoms,products:0,reference_atoms:atoms,inner_radius:ri,outer_radius:ro,length:L,multiplicity:1,
  sigma:law.boronSigma,escape_depth:response.escapeDepth_m,collection:response.collectionFraction,
  binding_emission:[law.boronEmission_J[0]!,law.boronEmission_J[1]!],thermalRecipientId:'COLLECTOR'})
 const seen=new Set<string>()
 for(const e of converter.incidence){const own=regions.get(e.sourceRegionId)
  if(!own||seen.has(e.sourceRegionId)||!(Number.isFinite(e.area_m2)&&e.area_m2>0))throw Error('Unknown/duplicated converter incidence')
  seen.add(e.sourceRegionId);intersections.push({target,region:own.i,share:e.area_m2/carrierArea})
 }
 near(sum(converter.incidence.map(e=>e.area_m2)),carrierArea,'whole converter incidence')
 return {targets,intersections,globalTargetIds:targets.map(t=>t.id),converterTarget:target,
  converterGeometry:{carrierArea_m2:carrierArea,outerFilmArea_m2:outerArea,filmVolume_m3:Math.PI*(ro-ri)*(ro+ri)*L,outerBlackCoefficient_m2:outerArea/4},
  projection:'ORIGINAL body volume fractions, verified against physical lateral shares; converter carrier arc-area FRACTIONS distribute the actual outer-film integral. No cut-created end surfaces.',
  quadrature:'48 axial-angle points; 48 transformed impact-angle points per actual bore/outer-escape boundary interval; 24 outer-shell depth points',
  completeReactorOperator:false,emissionIsDepositedHeat:false,acquiredInstrument:false,
  scope:'Finite ORIGINAL homogeneous B10 body/annular-converter capture and selected geometric charged escape/collected expectation only. End-face/long-cylinder and local uniform incident-flux approximations; no births, isotope evolution, source time solve, photon deposition or acquired detector history.'}
}

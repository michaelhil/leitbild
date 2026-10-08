/** Consumed physical input for the bounded cold axial apparatus. The native
 * kernel, not this preparation, determines attained body/stem/reference poses.
 * No ORIGINAL source incidence or source/fuel history is advanced here. */
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {z} from 'zod'
import {currentPhysicalPrimaryGeometry} from './reference-design-primary-physical-geometry'
import {compileOperatingNetwork,helperIdentities,type HydraulicSegment} from './reference-design-operating-network'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {currentColdGeometry} from './reference-design-current-cold-parent'
import {transferAttachmentChecks} from './reference-design-fuel-transfer'
import {parseDcBasis} from './reference-design-dc-sequence'
import {parse304Caloric} from './reference-design-source-barrel'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileControlMaterialMotion,controlMaterialMotionAt} from './reference-design-control-material-motion'

const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex')
const positive=z.number().finite().positive()
/** Discover the actual native implementation, not a manually maintained Rust
 * module list. A binary hash alone does not identify an uncommitted build. */
export async function controlMotionNativeSourceIdentities(){
 const root=resolve(import.meta.dir,'../native/process-plant'),paths=['Cargo.toml','Cargo.lock','build.rs','examples/control-motion.rs']
 for await(const path of new Bun.Glob('src/**/*.rs').scan({cwd:root}))paths.push(path)
 return Promise.all(paths.sort().map(async path=>({path,sha256:sha(await Bun.file(join(root,path)).bytes())})))
}
export const controlMotionAccuracy=z.object({
 burst_s:positive,hold_s:positive,maximum_step_s:positive,relative:positive,
 position_m:positive,velocity_m_s:positive,heat_J:positive,water_energy_J:positive,marker_kg:positive,
}).strict()
export type ControlMotionAccuracy=z.infer<typeof controlMotionAccuracy>

/** The actual operating-network passages are reused, including their original
 * detailed wall law, forms and grids. A serial sum is not a new effective K. */
export function controlMotionReturnPaths(network:Pick<Awaited<ReturnType<typeof compileOperatingNetwork>>,'hydraulic'>){
 const get=(id:string)=>{
  const rows=network.hydraulic.filter(q=>q.id===id)
  if(rows.length!==1)throw Error('Missing/duplicate current return passage '+id)
  return rows[0]!
 }
 return [
  {id:'EXTERNAL.CORE',parts:['LOWER->CORE.1','CORE.1->CORE.2','CORE.2->UPPER']},
  {id:'GUIDE.EMPTY',parts:['LOWER->GUIDE.EMPTY','GUIDE.EMPTY->UPPER']},
  {id:'GUIDE.THIMBLE',parts:['LOWER->GUIDE.THIMBLE','GUIDE.THIMBLE->UPPER']},
 ].map(row=>({...row,segments:row.parts.flatMap(id=>get(id).segments.map(s=>({...s}))),
  basis:row.parts.map(id=>get(id).basis)}))
}

/** The cold apparatus has one finite uniform-mixture LOWER and UPPER owner.
 * Actual return stocks are partitioned at the fixed physical core midplane;
 * they are not discarded, duplicated or left as an infinite prescribed bath. */
export function controlMotionBulkGeometry(network:Pick<Awaited<ReturnType<typeof compileOperatingNetwork>>,'water'>,
 guides:Awaited<ReturnType<typeof currentPhysicalPrimaryGeometry>>['input']['guideCohorts']['cohorts']){
 const get=(id:string)=>{
  const rows=network.water.filter(q=>q.id===id)
  if(rows.length!==1)throw Error('Missing/duplicate finite motion water '+id)
  return rows[0]!
 },lower=get('LOWER'),upper=get('UPPER'),out={
  lower:{volume_m3:lower.volume_m3,moment_m4:lower.volume_m3*lower.elevation_m,parts:['LOWER']},
  upper:{volume_m3:upper.volume_m3,moment_m4:upper.volume_m3*upper.elevation_m,parts:['UPPER']},
 }
 for(const [id,owner] of [['CORE.1','lower'],['CORE.2','upper']] as const){
  const w=get(id),p=out[owner];p.volume_m3+=w.volume_m3;p.moment_m4+=w.volume_m3*w.elevation_m;p.parts.push(id)
 }
 for(const name of ['EMPTY','THIMBLE']){
  const g=guides.find(g=>g.id===name),w=get('GUIDE.'+name)
  if(!g||!(g.bottom_m<0&&g.top_m>0))throw Error('Unrepresented current guide return extent')
  const A=g.singleArea_m2*g.count
  if(Math.abs(A*(g.top_m-g.bottom_m)-w.volume_m3)>1e-11*w.volume_m3
   ||Math.abs(A*(g.top_m**2-g.bottom_m**2)/2-w.volume_m3*w.elevation_m)>1e-11*w.volume_m3)
   throw Error('Guide return stock coverage')
  for(const [owner,lo,hi]of [['lower',g.bottom_m,0],['upper',0,g.top_m]] as const){
   const p=out[owner],V=A*(hi-lo);p.volume_m3+=V;p.moment_m4+=V*(lo+hi)/2;p.parts.push('GUIDE.'+name+'/'+owner)
  }
 }
 return out
}

/** Every collar has its actual axial support. The native stage clips these
 * fixed housing passages against the attained moving stem, not ORIGINAL L. */
export function controlMotionStemPassages(c:{headBottom_m:number,housingTop_m:number,neckTop_m:number,
 housingID_m:number,neckID_m:number,collarID_m:number,collarHeight_m:number,collarBottoms_m:readonly number[]}){
 const cuts=[c.housingTop_m,c.neckTop_m,...c.collarBottoms_m.flatMap(z=>[z,z+c.collarHeight_m])].sort((a,b)=>a-b)
 if(![c.headBottom_m,c.housingTop_m,c.neckTop_m,c.housingID_m,c.neckID_m,c.collarID_m,c.collarHeight_m,...c.collarBottoms_m].every(Number.isFinite)
  ||!(c.headBottom_m<c.housingTop_m&&c.housingTop_m<c.neckTop_m&&c.housingID_m>c.neckID_m&&c.neckID_m>c.collarID_m&&c.collarID_m>0&&c.collarHeight_m>0)
  ||new Set(cuts).size!==cuts.length||cuts.some(z=>z<c.housingTop_m||z>c.neckTop_m)
  ||c.collarBottoms_m.some((z,i)=>c.collarBottoms_m.slice(i+1).some(t=>Math.min(z+c.collarHeight_m,t+c.collarHeight_m)>Math.max(z,t))))
  throw Error('Overlapping/out-of-neck physical collar')
 return [{bottom_m:c.headBottom_m,top_m:c.housingTop_m,outer_radius_m:c.housingID_m/2},
  ...cuts.slice(1).map((hi,i)=>{const lo=cuts[i]!,mid=(lo+hi)/2,
   collar=c.collarBottoms_m.some(z=>mid>z&&mid<z+c.collarHeight_m)
   return {bottom_m:lo,top_m:hi,outer_radius_m:(collar?c.collarID_m:c.neckID_m)/2}
  })]
}

export async function compileConnectedControlMotion(wikiDirectory:string,selection:ControlMotionAccuracy){
 const accuracy=controlMotionAccuracy.parse(selection),wiki=resolve(wikiDirectory),
  [physical,network,dcText,controlBoundary,caloricText]=await Promise.all([
   currentPhysicalPrimaryGeometry(wiki),compileOperatingNetwork(wiki,{horizon_s:60,remainingBudget_s:120}),
   Bun.file(join(wiki,'systems/electrical/dc-storage.md')).text(),
   Bun.file(join(wiki,'systems/reactor/control-and-verification.md')).text(),
   Bun.file(join(wiki,'systems/primary-coolant/heater-equipment.md')).text(),
  ]),d=physical.physicalInputs,c=d.control,h=d.handling,
  cg=controlAbsorberGeometry(c,d.fuel,h),a=transferAttachmentChecks(d.attachment,c,d.fuel,h).geometry,
  current=currentColdGeometry(c,d.attachment,d.fuel,h,d.gates,d.head,d.cold),dc=parseDcBasis(dcText),caloric=parse304Caloric(caloricText),
  deadline=controlBoundary.match(/deadline \*\*([\d.]+) s later\*\*/),
  advance=controlBoundary.match(/at \*\*([\d.]+) stroke\*\* positive requested reference advance/)
 if(!deadline||!advance||accuracy.burst_s>Number(deadline[1])
  ||accuracy.burst_s*c.ordinarySpeedLimit_m_s/c.normalTravel_m>Number(advance[1])+1e-15)
  throw Error('Qualification request exceeds the current positive-burst boundary')
 const bodyVolume=cg.rodlets/c.clusters*Math.PI*(c.bodyDiameter_m/2)**2*c.bodyLength_m,
  stemVolume=a.headCapturedStem_kg/(c.clusters*c.steelDensity_kg_m3),spiderVolume=c.spiderMass_kg/c.steelDensity_kg_m3,
  stemParts=current.intruders.filter(p=>['52 stem plus lower stubs','two opposed lugs per stem','annular shoulders'].includes(p.name)),
  stemMoment=stemParts.reduce((s,p)=>s+p.area*(p.hi-p.lo)*(p.hi+p.lo)/2,0)/c.clusters,
  bulk=controlMotionBulkGeometry(network,physical.input.guideCohorts.cohorts),returns=controlMotionReturnPaths(network),
  ownerIdentities=[...network.ownerIdentities,{name:'systems/electrical/dc-storage.md',sha256:sha(dcText)},
   {name:'systems/reactor/control-and-verification.md',sha256:sha(controlBoundary)},
   {name:'systems/primary-coolant/heater-equipment.md',sha256:sha(caloricText)}],
  bodySteel=cg.moving.bodySteel_kg/c.clusters,b4c=cg.moving.b4c_kg/c.clusters,
  frame={count:c.clusters,anchor:{pressure_Pa:d.anchor.pressure_Pa,temperature_K:d.anchor.temperature_K,
   markerRatio:d.cold.primaryAbsorberRatio,elevation_m:d.anchor.elevation_m},bulk,
   motion:{body_mass_kg:bodySteel+b4c+c.spiderMass_kg,stem_mass_kg:a.headCapturedStem_kg/c.clusters,
    force_limit_n:c.forceLimitPerCluster_N,grip_closed_force_n:c.forceLimitPerCluster_N,gap_stroke_m:c.gapStroke_m,
    maximum_rate_m_s:c.ordinarySpeedLimit_m_s,efficiency:c.driveEfficiency,joint_capacity_n:d.attachment.jointCapacity_N},
   cluster:{outer_radius_m:h.guideInnerDiameter_m/2,body_radius_m:c.bodyDiameter_m/2,
    bottom_m:h.seatedBottom_m,top_m:current.faTop_m,rodlets:c.rodletsPerCluster,body_volume_m3:bodyVolume,
    spider_volume_m3:spiderVolume,stem_volume_m3:stemVolume,roughness_m:c.guideRoughness_m,mouth_loss:c.endLossEach,
    stem_bottom_m:c.spiderBottom_m+c.spiderHeight_m-d.attachment.stubLength_m,
    stem_top_m:c.spiderBottom_m+c.spiderHeight_m+c.stemLength_m,stem_radius_m:c.stemDiameter_m/2,
    stem_original_mean_m:stemMoment/stemVolume,
    spider_original_mean_m:(current.intruders.filter(p=>p.name==='redistributed porous spider remainder'||p.name==='actual hub land minus bore/key slots')
     .reduce((s,p)=>s+p.area*(p.hi-p.lo)*(p.lo+p.hi)/2,0)/c.clusters)/spiderVolume},
   stemPassages:controlMotionStemPassages(c),returns,
   dc:{capacity_j:dc.usableEnergy_kWh*3.6e6,normal_group_w:dc.continuousDuty_W,charger_limit_w:dc.chargerLimit_W,
    output_limit_w:dc.outputLimit_W,charge_efficiency:dc.chargeEfficiency,discharge_efficiency:dc.dischargeEfficiency,
    converter_efficiency:dc.converterEfficiency},
   initialSupport:{initialEnergy_J:dc.usableEnergy_kWh*3.6e6,charger:false,battery:true,output:true},
   duty:{base_a_w:dc.continuousDuty_W,base_b_w:dc.continuousDuty_W,holding_w:c.holdingDuty_W,
    controller_w:c.controllerDuty_W,motive_w:c.deliveredMotiveLimit_W},
   thermal:{body_steel_kg:bodySteel,body_b4c_kg:b4c,spider_kg:c.spiderMass_kg,
    stem_steel_kg:a.headCapturedStem_kg/c.clusters,jack_steel_kg:c.attachedJackMassPerCluster_kg,
    originalTemperature_K:d.cold.primaryMetalTemperature_K,caloric},
   accuracy,clusterIds:cg.sites.map((s,i)=>({id:`LD01.CR.${String(i+1).padStart(3,'0')}`,stockPrefix:`CONTROL/${s.x}/${s.y}`})),
   ownerIdentities,helperIdentities:await helperIdentities(import.meta.path),
   scope:'Fresh cold fully liquid all-cluster axial withdrawal/HOLD laboratory apparatus. Finite return water is mixed into actual LOWER/UPPER; outer primary loops are a computational cut. Adiabatic finite jack/stem/spider heat. Frozen native water properties at the declared cold anchor. No source/fuel evolution, controller/acquisition qualification, released insertion, head movement, detailed hot hydraulics or live LD-01 installation.',
  }
 const seen=new Map<string,string>()
 for(const q of [...physical.identity,...ownerIdentities]){
  if(seen.has(q.name)&&seen.get(q.name)!==q.sha256)throw Error('Physical owner changed during motion preparation '+q.name)
  seen.set(q.name,q.sha256)
 }
 const stemCheck=stemParts.reduce((s,p)=>s+p.area*(p.hi-p.lo),0)/c.clusters
 if(Math.abs(stemCheck-stemVolume)>1e-12*stemVolume)throw Error('Current stem inventory and axial geometry disagree')
 if(!(frame.cluster.stem_top_m< c.neckTop_m&&frame.cluster.stem_bottom_m>current.faTop_m))
  throw Error('Original complete moving stem is not inside declared enclosure')
 if(frame.duty.holding_w>frame.duty.base_a_w||frame.duty.controller_w>frame.duty.base_b_w)
  throw Error('Declared holding/controller duties exceed their existing base groups')
 return frame
}

const segmentValues=(s:HydraulicSegment)=>[s.kind,s.length_m,s.area_m2,s.diameter_m,s.roughness_m,s.fixedLoss,s.gridMultiplierOrAnnularDarcyCoefficient]
export function connectedControlMotionInput(p:Awaited<ReturnType<typeof compileConnectedControlMotion>>){
 const m=p.motion,g=p.cluster,d=p.dc,a=p.accuracy,s=p.initialSupport
 return [
  [p.count,p.anchor.pressure_Pa,p.anchor.temperature_K,p.anchor.markerRatio,p.anchor.elevation_m],
  [p.bulk.lower.volume_m3,p.bulk.lower.moment_m4,p.bulk.upper.volume_m3,p.bulk.upper.moment_m4],
  [m.body_mass_kg,m.stem_mass_kg,m.force_limit_n,m.grip_closed_force_n,m.gap_stroke_m,m.maximum_rate_m_s,m.efficiency,m.joint_capacity_n],
  [g.outer_radius_m,g.body_radius_m,g.bottom_m,g.top_m,g.rodlets,g.body_volume_m3,g.spider_volume_m3,g.stem_volume_m3,g.roughness_m,g.mouth_loss,
   g.stem_bottom_m,g.stem_top_m,g.stem_radius_m,g.stem_original_mean_m,g.spider_original_mean_m],
  [p.stemPassages.length],...p.stemPassages.map(q=>[q.outer_radius_m,q.bottom_m,q.top_m]),
  [p.returns.length],...p.returns.map(q=>[q.segments.length,...q.segments.flatMap(segmentValues)]),
  ...[0,1].map(()=>[d.capacity_j,d.normal_group_w,d.charger_limit_w,d.output_limit_w,d.charge_efficiency,d.discharge_efficiency,d.converter_efficiency,
   s.initialEnergy_J,Number(s.charger),Number(s.battery),Number(s.output)]),
  [p.duty.base_a_w,p.duty.base_b_w,p.duty.holding_w,p.duty.motive_w],
  [m.maximum_rate_m_s,a.burst_s,a.hold_s,a.maximum_step_s,a.relative],
  [a.position_m,a.velocity_m_s,a.heat_J,a.water_energy_J,a.marker_kg],
 ].map(row=>row.join(' ')).join('\n')+'\n'
}

type MotionFrame=Awaited<ReturnType<typeof compileConnectedControlMotion>>
/** Exact inverse of the selected 304 enthalpy law. Heat is retained above the
 * original temperature, not converted using an invented constant capacity. */
export function controlMotionSteelTemperature(caloric:MotionFrame['thermal']['caloric'],original_K:number,mass_kg:number,heat_J:number){
 const c=caloric,a=c.cpConstant_J_kg_K,b=c.cpLinear_J_kg_K2,
  capacity=a+b*original_K,change=heat_J/mass_kg,discriminant=capacity*capacity+2*b*change
 if(![original_K,mass_kg,heat_J].every(Number.isFinite)||mass_kg<=0||original_K<c.minimum_K||original_K>c.maximum_K
  ||!(capacity>0&&discriminant>0))throw Error('Invalid finite 304 heat recipient')
 const delta=2*change/(capacity+Math.sqrt(discriminant)),temperature=original_K+delta,
  reconstructed=mass_kg*delta*(a+b*(temperature+original_K)/2)
 if(!Number.isFinite(temperature)||temperature<c.minimum_K||temperature>c.maximum_K
  ||Math.abs(reconstructed-heat_J)>64*Number.EPSILON*Math.max(Math.abs(heat_J),1))
  throw Error('Finite 304 heat exceeds selected caloric applicability')
 return temperature
}

/** An independent receipt check, not a second advancement kernel. This derives
 * current water shapes directly from actual attained poses and verifies the
 * unchanged finite starts, conserved stocks and finite thermal recipients. */
export function auditConnectedControlMotion(frame:MotionFrame,result:unknown){
 const finite=z.number().finite(),n=frame.count,nodes=n+2,g=frame.cluster,gravity=9.80665,
  motion=z.tuple([finite,finite,finite,finite,finite]),heat=z.tuple([finite,finite,finite]),
  sample=z.object({time_s:finite.nonnegative(),motion:z.array(motion).length(n),heat:z.array(heat).length(n),
   external:z.array(finite).length(2*nodes),support:z.array(z.tuple([finite,finite,finite,finite])).length(2),
   exports_J:z.tuple([finite,finite]),mass_kg:finite.positive(),marker_kg:finite.nonnegative()}).passthrough(),
  run=z.object({samples:z.array(sample).min(2)}).passthrough(),
  r=z.object({status:z.literal('PASS'),paired_maximum_ratio:finite.min(0).max(1),normal:run,tighter:run}).passthrough().parse(result),
  solid=g.rodlets*Math.PI*g.body_radius_m**2,annulus=g.rodlets*Math.PI*(g.outer_radius_m**2-g.body_radius_m**2),
  guideOriginalVolume=annulus*(g.top_m-g.bottom_m),guideOriginalMoment=annulus*(g.top_m**2-g.bottom_m**2)/2,
  originalVolume=frame.bulk.lower.volume_m3+frame.bulk.upper.volume_m3+n*guideOriginalVolume,
  originalMoment=frame.bulk.lower.moment_m4+frame.bulk.upper.moment_m4+n*guideOriginalMoment,
  initial=r.normal.samples[0]!,rho=initial.mass_kg/originalVolume,
  thermalMasses=[frame.thermal.jack_steel_kg,frame.thermal.stem_steel_kg,frame.thermal.spider_kg],
  sameStart=(a:typeof initial,b:typeof initial)=>JSON.stringify([a.time_s,a.motion,a.heat,a.external,a.support,a.exports_J])
   ===JSON.stringify([b.time_s,b.motion,b.heat,b.external,b.support,b.exports_J])
 if(!sameStart(initial,r.tighter.samples[0]!))throw Error('Refinement changed the original finite stocks')
 if(r.normal.samples.length!==r.tighter.samples.length
  ||r.normal.samples.some((s,i)=>s.time_s!==r.tighter.samples[i]!.time_s)
  ||r.normal.samples.at(-1)!.time_s!==frame.accuracy.burst_s+frame.accuracy.hold_s)
  throw Error('Refinement observations or completed physical horizon disagree')
 if(initial.time_s!==0||initial.motion.some(m=>m.some(x=>x!==0))||initial.heat.some(h=>h.some(x=>x!==0))
  ||initial.exports_J.some(x=>x!==0)||initial.support.some(s=>s[0]!==frame.initialSupport.initialEnergy_J||s.slice(1).some(x=>x!==0)))
  throw Error('Motion witness did not retain declared original mechanical/thermal/support stocks')
 const summaries=([['normal',r.normal],['tighter',r.tighter]]as const).map(([name,arm])=>{
  let maximumMassDefect_kg=0,maximumMarkerDefect_kg=0,maximumFirstLawDefect_J=0,
   maximumShapeMomentDefect_m4=0,maximumSteelTemperature_K=frame.thermal.originalTemperature_K,previousTime=-1
  const initialEnergy=initial.external.slice(0,nodes).reduce((a,b)=>a+b,0),marker0=frame.anchor.markerRatio*initial.mass_kg
  let finalTemperatures:number[][]=[]
  for(const s of arm.samples){
   if(s.time_s<previousTime)throw Error('Motion receipt clock moved backwards')
   previousTime=s.time_s
   let upperV=frame.bulk.upper.volume_m3,upperJ=frame.bulk.upper.moment_m4,movingMoment=0
   const shapes=[{V:frame.bulk.lower.volume_m3,J:frame.bulk.lower.moment_m4}]
   for(const m of s.motion){
    const y=m[0],stemY=m[2],dv=solid*y,dj=solid*(g.bottom_m*y+y*y/2)
    if(y<0||y>=g.top_m-g.bottom_m||stemY<0)throw Error('Motion receipt outside declared current geometry')
    shapes.push({V:guideOriginalVolume+dv,J:guideOriginalMoment+dj})
    upperV-=dv;upperJ-=g.body_volume_m3*y+dj+g.spider_volume_m3*y+g.stem_volume_m3*stemY
    movingMoment+=(g.body_volume_m3+g.spider_volume_m3)*y+g.stem_volume_m3*stemY
   }
   shapes.push({V:upperV,J:upperJ})
   if(shapes.some(q=>!(q.V>0&&Number.isFinite(q.J))))throw Error('Invalid current finite water shape')
   const volume=shapes.reduce((s,q)=>s+q.V,0),moment=shapes.reduce((s,q)=>s+q.J,0),
    massDefect=Math.max(Math.abs(rho*volume-initial.mass_kg),Math.abs(s.mass_kg-rho*volume)),
    marker=s.external.slice(nodes).reduce((a,b)=>a+b,0),markerDefect=Math.max(Math.abs(marker-marker0),Math.abs(marker-s.marker_kg)),
    momentDefect=Math.abs(moment+movingMoment-originalMoment),
    mechanical=s.motion.reduce((sum,m)=>sum+frame.motion.body_mass_kg*(m[1]*m[1]/2+gravity*m[0])
     +frame.motion.stem_mass_kg*(m[3]*m[3]/2+gravity*m[2]),0),
    retainedHeat=s.heat.flat().reduce((a,b)=>a+b,0),waterEnergy=s.external.slice(0,nodes).reduce((a,b)=>a+b,0)-initialEnergy,
    exports=s.exports_J.reduce((a,b)=>a+b,0),supplied=s.support.reduce((sum,q)=>sum+q[2],0),
    energyDefect=Math.abs(mechanical+retainedHeat+waterEnergy+exports-supplied),
    arithmeticEnergyBound=1e-6+4096*Number.EPSILON*(Math.abs(mechanical)+Math.abs(retainedHeat)+Math.abs(initialEnergy)
     +Math.abs(waterEnergy)+Math.abs(exports)+Math.abs(supplied))
   if(massDefect>128*Number.EPSILON*initial.mass_kg||markerDefect>1e-10+256*Number.EPSILON*marker0
    ||momentDefect>256*Number.EPSILON*Math.max(Math.abs(originalMoment),1)||energyDefect>arithmeticEnergyBound)
    throw Error(`Independent ${name} retained stock/energy audit failed at ${s.time_s}s: ${JSON.stringify({massDefect,markerDefect,momentDefect,energyDefect,arithmeticEnergyBound})}`)
   for(let i=0;i<nodes;i++){
    const marker=s.external[nodes+i]!
    if(marker<0||marker>rho*shapes[i]!.V)throw Error('Invalid retained marker concentration')
    if(s.time_s===0&&(Math.abs(marker-frame.anchor.markerRatio*rho*shapes[i]!.V)>128*Number.EPSILON*Math.max(marker,1)
     ||Math.abs(s.external[i]!-rho*gravity*shapes[i]!.J)>256*Number.EPSILON*Math.max(Math.abs(s.external[i]!),1)))
     throw Error('Native motion start changed declared finite water energy or marker')
   }
   finalTemperatures=s.heat.map(h=>h.map((q,i)=>{
    if(q<0)throw Error('Negative retained mechanical heat')
    const t=controlMotionSteelTemperature(frame.thermal.caloric,frame.thermal.originalTemperature_K,thermalMasses[i]!,q)
    maximumSteelTemperature_K=Math.max(maximumSteelTemperature_K,t);return t
   }))
   maximumMassDefect_kg=Math.max(maximumMassDefect_kg,massDefect)
   maximumMarkerDefect_kg=Math.max(maximumMarkerDefect_kg,markerDefect)
   maximumFirstLawDefect_J=Math.max(maximumFirstLawDefect_J,energyDefect)
   maximumShapeMomentDefect_m4=Math.max(maximumShapeMomentDefect_m4,momentDefect)
  }
  return {arm:name,samples:arm.samples.length,maximumMassDefect_kg,maximumMarkerDefect_kg,maximumFirstLawDefect_J,
   maximumShapeMomentDefect_m4,maximumSteelTemperature_K,
   finalSteelTemperatures_K:finalTemperatures,thermalColumnOrder:['jack','stem','spider']}
 })
 return {status:'PASS',densityAtOriginalAnchor_kg_m3:rho,originalFiniteVolume_m3:originalVolume,
  originalMass_kg:initial.mass_kg,originalMarker_kg:frame.anchor.markerRatio*initial.mass_kg,
  finiteThermalLaw:'Selected 304 cp(T)=a+bT; adiabatic heat above unchanged original temperature',arms:summaries,
  sourceHistoryAdvanced:false}
}

/** Reuse the already qualified fixed-union BODY mapper on attained native
 * poses. Only the material geometry it consumes is prepared: no atomic target,
 * product, neutron, optical or thermal history is initialized or advanced. */
export async function auditAttainedControlMaterialGeometry(wiki:string,frame:MotionFrame,result:unknown){
 const physical=await currentPhysicalPrimaryGeometry(resolve(wiki)),d=physical.physicalInputs,
  owners=new Map(frame.ownerIdentities.map(q=>[q.name,q.sha256]))
 for(const q of physical.identity)if(owners.get(q.name)!==q.sha256)
  throw Error('Physical geometry owner changed before attained material audit '+q.name)
 const cg=controlAbsorberGeometry(d.control,d.fuel,d.handling),
  stocks=cg.sites.flatMap(s=>[
   {id:`CONTROL/${s.x}/${s.y}/B4C`,material:'B4C' as const,volume_m3:cg.moving.b4c_kg/(d.control.clusters*d.handling.b4cDensity_kg_m3)},
   {id:`CONTROL/${s.x}/${s.y}/STEEL`,material:'steel304' as const,volume_m3:cg.moving.bodySteel_kg/(d.control.clusters*d.control.steelDensity_kg_m3)},
  ]),plan=compileControlMaterialMotion(compileSourcePartition(d).regions,d,stocks),
  finite=z.number().finite(),motion=z.tuple([finite,finite,finite,finite,finite]),
  arm=z.object({samples:z.array(z.object({time_s:finite,motion:z.array(motion).length(frame.count)})).min(2)}),
  r=z.object({status:z.literal('PASS'),normal:arm,tighter:arm}).parse(result),
  identity=JSON.stringify([plan.clusters,plan.stockIds,plan.regionIds]),
  zero=controlMaterialMotionAt(plan,plan.clusters.map(c=>({clusterId:c.id,body_y_m:0,side:'increasing'})))
 if(plan.clusters.some((c,i)=>c.id!==frame.clusterIds[i]?.id||c.prefix!==frame.clusterIds[i]?.stockPrefix)
  ||stocks.length!==2*frame.count)throw Error('Attained BODY material identity differs from physical fleet')
 const originalMoments=stocks.map(()=>0)
 for(const [i,row]of plan.rows.entries())originalMoments[row.stock]!+=zero[4*i+2]!
 const summaries=([['normal',r.normal],['tighter',r.tighter]]as const).map(([name,arm])=>{
  let maximumVolumeDefect_m3=0,maximumMomentDefect_m4=0,maximumChangedIncidenceRows=0
  for(const sample of arm.samples){
   // At a stationary interior pose either branch gives the same V/J; the
   // side is explicit for derivatives, which are not credited by this audit.
   const values=controlMaterialMotionAt(plan,sample.motion.map((m,i)=>({clusterId:plan.clusters[i]!.id,
    body_y_m:m[0],side:m[1]<0?'decreasing':'increasing'}))),volumes=stocks.map(()=>0),moments=stocks.map(()=>0)
   let changed=0
   for(const [i,row]of plan.rows.entries()){
    volumes[row.stock]!+=values[4*i]!;moments[row.stock]!+=values[4*i+2]!
    if(Math.abs(values[4*i]!-zero[4*i]!)>4e-10*stocks[row.stock]!.volume_m3)changed++
   }
   for(const [i,stock]of stocks.entries()){
    const cluster=Math.floor(i/2),expectedJ=originalMoments[i]!+stock.volume_m3*sample.motion[cluster]![0],
     volumeDefect=Math.abs(volumes[i]!-stock.volume_m3),momentDefect=Math.abs(moments[i]!-expectedJ),
     tolerance=4e-10*stock.volume_m3
    if(volumeDefect>tolerance||momentDefect>tolerance*Math.max(1,d.control.normalTravel_m,Math.abs(expectedJ/stock.volume_m3)))
     throw Error('Attained BODY geometry failed rigid finite-stock conservation '+stock.id+' at '+sample.time_s)
    maximumVolumeDefect_m3=Math.max(maximumVolumeDefect_m3,volumeDefect)
    maximumMomentDefect_m4=Math.max(maximumMomentDefect_m4,momentDefect)
   }
   maximumChangedIncidenceRows=Math.max(maximumChangedIncidenceRows,changed)
  }
  if(maximumChangedIncidenceRows===0)throw Error('Attained poses did not change existing source material incidence')
  return {arm:name,samples:arm.samples.length,maximumVolumeDefect_m3,maximumMomentDefect_m4,maximumChangedIncidenceRows}
 })
 if(JSON.stringify([plan.clusters,plan.stockIds,plan.regionIds])!==identity)
  throw Error('Attained material evaluation mutated immutable physical/source identities')
 return {status:'PASS',clusters:plan.clusters.length,materialStocks:stocks.length,materialStockIds:plan.stockIds,
  fixedUnionRows:plan.rows.length,sourceRegions:plan.regionIds.length,arms:summaries,
  scope:'Existing BODY B4C/steel geometry evaluated at attained poses. No neutron/source, material-target/product history, optical response, thermal-contact or fuel evolution.'}
}

if(import.meta.main){
 const [wiki,binary,output,budget,...extra]=Bun.argv.slice(2),allowance=Number(budget)
 if(!wiki||!binary||!output||extra.length||!Number.isFinite(allowance)||allowance<=0||allowance>120)
  throw Error('Usage: connected-control-motion <LD01 wiki> <native control-motion binary> <NEW receipt.json> <wall allowance <=120 s>')
 const start=performance.now(),binarySha256=sha(await Bun.file(resolve(binary)).bytes()),
  nativeSourceIdentities=await controlMotionNativeSourceIdentities(),frame=await compileConnectedControlMotion(wiki,{burst_s:.5,hold_s:60,maximum_step_s:.1,
  relative:1e-6,position_m:1e-9,velocity_m_s:1e-9,heat_J:1e-7,water_energy_J:1e-7,marker_kg:1e-11}),
  nativeInput=connectedControlMotionInput(frame),remaining=allowance-(performance.now()-start)/1000
 if(remaining<=1)throw Error('Motion preparation left no native execution plus failure-serialization allowance')
 const child=Bun.spawn([resolve(binary),String(remaining-1)],{stdin:Buffer.from(nativeInput),stdout:'pipe',stderr:'pipe'}),
  timer=setTimeout(()=>child.kill(),remaining*1000)
 let stdout:string,stderr:string,code:number
 try{[stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])}
 finally{clearTimeout(timer)}
 let result:unknown=null,independentAudit:ReturnType<typeof auditConnectedControlMotion>|null=null,
  attainedMaterialGeometryAudit:Awaited<ReturnType<typeof auditAttainedControlMaterialGeometry>>|null=null,inspectionError:string|null=null
 if(code===0){
  try{result=JSON.parse(stdout!);independentAudit=auditConnectedControlMotion(frame,result)
   attainedMaterialGeometryAudit=await auditAttainedControlMaterialGeometry(wiki,frame,result)}
  catch(error){inspectionError=error instanceof Error?error.message:String(error)}
 }
 if(binarySha256!==sha(await Bun.file(resolve(binary)).bytes()))inspectionError='Native binary changed during qualification'
 if(JSON.stringify(nativeSourceIdentities)!==JSON.stringify(await controlMotionNativeSourceIdentities()))
  inspectionError='Native source changed during qualification'
 const elapsedSeconds=(performance.now()-start)/1000,
  receipt={frame,nativeInputSha256:sha(nativeInput),compilerSha256:sha(await Bun.file(import.meta.path).text()),
   binarySha256,nativeSourceIdentities,elapsedSeconds,nativeExit:code!,nativeStderr:stderr!,result,
   independentAudit,attainedMaterialGeometryAudit,inspectionError,...(result===null?{nativeStdout:stdout!}:{}),liveModelInstalled:false}
 await writeFile(resolve(output),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 if(code!==0||inspectionError||elapsedSeconds>allowance)
  throw Error('Native motion qualification failed or exceeded aggregate allowance; receipt retained at '+resolve(output)+(inspectionError?': '+inspectionError:''))
 console.log(JSON.stringify({receipt:resolve(output),elapsedSeconds,status:independentAudit!.status,
  pairedMaximumRatio:(result as {paired_maximum_ratio:number}).paired_maximum_ratio,
  independentAudit:{...independentAudit!,arms:independentAudit!.arms.map(({finalSteelTemperatures_K,...summary})=>summary)},
  attainedMaterialGeometryAudit:{...attainedMaterialGeometryAudit,materialStockIds:undefined}}))
}

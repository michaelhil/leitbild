/** Prospective bounded cold release input. This binds existing material and
 * hardware; it prepares no pose, liquid stock, reaction history or density.
 * The historical motion frame is deliberately not changed by this helper. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import type {ControlSourceMotion} from './reference-design-control-source-motion'
import type {PassiveStock} from './reference-design-source-passive'
import {controlMotionStemPassages} from './reference-design-connected-control-motion'

const schema=z.object({configuration:z.literal('offline-paid-lift-physical-release'),lift_m:z.literal(.25),
 neckInertance:z.literal('piecewise-shaft-shoulder-plug-fixed-initial-UPPER-density'),
 neckAreaChangeLoss:z.literal('geometric-small-area-sudden-change-with-moving-shoulder'),
 broadDrag:z.literal('quiescent-UPPER-envelope-disk-1.28'),
 normalStop:z.enum(['backdrivable-coast-to-hold','anchored-reference-full-grip-brake']),
 maximumInertanceDensityRelativeDeparture:z.literal(.01),
 impact:z.literal('fully-inelastic-no-grip-impulse'),movingImpactHeatFraction:z.literal(.5),
 receiverThermal:z.literal('adiabatic-impact-increment-only'),
 localPressureAdmission:z.literal('serial-absolute-above-current-saturation')}).strict()
export function parseColdControlRelease(document:string){
 return schema.parse(configurationBlock(document,'reference-cold-control-release'))
}
export type ColdControlRelease=ReturnType<typeof parseColdControlRelease>
export function coldControlReleaseMinimumStem(selected:ColdControlRelease,
 c:{collarBottoms_m:readonly number[];collarHeight_m:number},a:{shoulderBottom_m:number}){
 schema.parse(selected)
 const minimum=c.collarBottoms_m[1]!+c.collarHeight_m-a.shoulderBottom_m
 if(c.collarBottoms_m.length!==2||!Number.isFinite(minimum)||minimum>=0)
  throw Error('Cold release shoulder has no actual downward collar-capture travel')
 return minimum
}
type Geometry={d:{control:Pick<ControlSourceMotion['d']['control'],'clusters'|'gapArmature_kg'|'gapStroke_m'|
 'gapSpring_N_m'|'gapDamping_N_s_m'|'attachedJackMassPerCluster_kg'|'collarBottoms_m'|'collarHeight_m'|
 'collarID_m'|'collarOD_m'|'steelDensity_kg_m3'|'headBottom_m'|'housingTop_m'|'neckTop_m'|
 'housingID_m'|'neckID_m'|'stemDiameter_m'|'spiderBottom_m'|'spiderHeight_m'|'spiderRadius_m'|'stemLength_m'>;
 attachment:Pick<ControlSourceMotion['d']['attachment'],'shoulderBottom_m'|'stubLength_m'|'shoulderDiameter_m'|
 'shoulderHeight_m'|'lugWidth_m'|'lugOuterRadius_m'>;
 handling:Pick<ControlSourceMotion['d']['handling'],'topFitting_kg'>;
 fuel:Pick<ControlSourceMotion['d']['fuel'],'cladDensity_kg_m3'>};
 motion:{clusters:readonly {id:string}[]};clusterFA:readonly (string|undefined)[];
 water:readonly {id:string}[];upper:number;maximumStemPose_m:number}
type Stock=Pick<PassiveStock,'id'|'material'|'volume_m3'|'mass_kg'|'original_K'>&{targets:readonly {id:string}[]}
type Source={material:{materialPayload:{passive:{stocks:readonly Stock[]}},nativeInputs:{targets:readonly {id:string}[]}}}
function same(a:number,b:number,label:string){
 // These immutable whole-stock formulas use short IEEE754 expression chains:
 // circles, density products and the original top-fitting's single lumped
 // UPPER incidence (source-material.ts), not spatial quadrature or a new
 // physical acceptance tolerance. 64 roundoffs covers their regrouping.
 const relative=64*Number.EPSILON
 if(!Number.isFinite(a+b)||a<=0||b<=0||Math.abs(a-b)>relative*Math.max(a,b))
  throw Error('Cold release physical identity differs: '+label)
}

/** Numeric order: cluster count, lift, minimum STEM, armature mass/stroke/k/b,
 * density applicability, moving impact share; HEAD.JACKS [four targets,V,m];
 * then each immutable cluster's
 * fitting [Zr target,V,m,T0] and upper collar [four targets,whole V,whole m,
 * stock fraction,slice m,T0]; finally shoulder[R,bottom,top], broad body/stem
 * surrogate areas andCd; normal-stop policy(1=backdrivablecoast,0=anchoredbrake).
 * Native binds rho0 only after admitted initial IC.
 * Stock/target ids and indices remain in metadata for independent reconstruction.
 * These are impact increments, not complete fitting/collar thermal models. */
export function controlReleasePhysicalInput(plan:Geometry,source:Source,selected:ColdControlRelease){
 const selection=schema.parse(selected),c=plan.d.control,n=c.clusters,stocks=source.material.materialPayload.passive.stocks,
  targets=source.material.nativeInputs.targets,sourceIds=new Map(targets.map((t,i)=>[t.id,i])),
  stockIds=new Map(stocks.map((s,i)=>[s.id,i]))
 if(n!==52||plan.motion.clusters.length!==n||plan.clusterFA.length!==n
  ||new Set(plan.motion.clusters.map(s=>s.id)).size!==n||new Set(plan.clusterFA).size!==n
  ||plan.clusterFA.some(id=>!id)||plan.water[plan.upper]?.id!=='UPPER'
  ||stockIds.size!==stocks.length||sourceIds.size!==targets.length)
  throw Error('Cold release requires complete distinct actual cluster/material/water identities')
 if(![c.gapArmature_kg,c.gapStroke_m,c.gapSpring_N_m,c.gapDamping_N_s_m,c.attachedJackMassPerCluster_kg,
  c.collarHeight_m,c.collarID_m,c.collarOD_m,c.steelDensity_kg_m3,c.spiderRadius_m,plan.d.handling.topFitting_kg,
  plan.d.fuel.cladDensity_kg_m3].every(v=>Number.isFinite(v)&&v>0)
  ||c.gapArmature_kg>=c.attachedJackMassPerCluster_kg||c.collarOD_m<=c.collarID_m
  ||c.collarBottoms_m.length!==2||c.collarBottoms_m.some(v=>!Number.isFinite(v))
  ||c.collarBottoms_m[0]!+c.collarHeight_m>c.collarBottoms_m[1]!)
  throw Error('Cold release hardware lies outside the selected finite geometry')
 const minimumStemPose_m=coldControlReleaseMinimumStem(selection,c,plan.d.attachment)
 const stemBottom_m=c.spiderBottom_m+c.spiderHeight_m-plan.d.attachment.stubLength_m,
  stemTop_m=c.spiderBottom_m+c.spiderHeight_m+c.stemLength_m,passages=controlMotionStemPassages(c),
  shaftArea_m2=Math.PI*(c.stemDiameter_m/2)**2
 if(!Number.isFinite(stemBottom_m+stemTop_m+plan.maximumStemPose_m+shaftArea_m2)
  ||plan.maximumStemPose_m<selection.lift_m||stemBottom_m+minimumStemPose_m<=c.spiderBottom_m
  ||stemBottom_m+plan.maximumStemPose_m>=c.headBottom_m
  ||stemTop_m+plan.maximumStemPose_m>=c.neckTop_m||c.stemDiameter_m>=c.collarID_m
  ||plan.d.attachment.shoulderDiameter_m<=c.collarID_m||plan.d.attachment.shoulderDiameter_m>=c.neckID_m)
 throw Error('Cold release shaft/shoulder loses its actual cold enclosure or fitting clearance')
 const a=plan.d.attachment,shoulder={radius_m:a.shoulderDiameter_m/2,bottom_m:a.shoulderBottom_m,
  top_m:a.shoulderBottom_m+a.shoulderHeight_m},broadDrag={body_area_m2:Math.PI*c.spiderRadius_m**2,
   stem_area_m2:shaftArea_m2+2*a.lugWidth_m*(a.lugOuterRadius_m-c.stemDiameter_m/2),coefficient:1.28,
   fluidReference:'quiescent-local-UPPER-cold-reduction' as const,
   coefficientSensitivity:[.64,2.56] as const}
 if(![a.shoulderHeight_m,a.lugWidth_m,a.lugOuterRadius_m].every(v=>Number.isFinite(v)&&v>0)
  ||a.lugOuterRadius_m<=c.stemDiameter_m/2||shoulder.top_m!==stemTop_m
  ||shoulder.bottom_m+minimumStemPose_m<passages.at(-1)!.bottom_m
  ||c.spiderRadius_m>=c.housingID_m/2)
  throw Error('Cold release shoulder or broad-drag surrogate differs from actual bounded enclosure')
 const neckInterfaces=passages.slice(1).map((q,i)=>{
  const p=passages[i]!,plane_m=q.bottom_m,
   lowerArea_m2=Math.PI*p.outer_radius_m**2-shaftArea_m2,upperArea_m2=Math.PI*q.outer_radius_m**2-shaftArea_m2,
   ratio=Math.min(lowerArea_m2,upperArea_m2)/Math.max(lowerArea_m2,upperArea_m2)
  if(p.top_m!==plane_m||stemBottom_m+plan.maximumStemPose_m>=plane_m||stemTop_m+minimumStemPose_m<=plane_m
   ||!(lowerArea_m2>0&&upperArea_m2>0&&ratio>0&&ratio<1))
   throw Error('Cold release area-change interface is not actually shaft-occupied throughout signed travel')
  return {plane_m,lowerArea_m2,upperArea_m2,contractionK:.5*(1-ratio)**.75,expansionK:(1-ratio)**2}
 })
 if(neckInterfaces.length!==5)throw Error('Cold release requires the actual five neck/collar interfaces')
 const bind=(id:string,material:Stock['material'],elements:readonly string[])=>{
  const stock=stockIds.get(id),s=stock===undefined?undefined:stocks[stock]
  if(!s||s.material!==material||s.original_K!==300||s.targets.length!==elements.length
   ||s.targets.some((t,i)=>t.id!==id+'/'+elements[i]))
   throw Error('Cold release recipient lacks its actual original material: '+id)
  const bound=elements.map(e=>sourceIds.get(id+'/'+e))
  if(bound.some(i=>i===undefined))throw Error('Cold release recipient target identity missing: '+id)
  return {id,stock:stock!,targets:bound as number[],volume_m3:s.volume_m3,mass_kg:s.mass_kg,original_K:s.original_K}
 },collars=bind('HEAD.COLLARS','steel304',['Fe','Cr','Ni','Mn']),
  jacks=bind('HEAD.JACKS','steel304',['Fe','Cr','Ni','Mn']),
  collarVolume_m3=Math.PI*(c.collarOD_m**2-c.collarID_m**2)*c.collarHeight_m/4,
  collarMass_kg=collarVolume_m3*c.steelDensity_kg_m3,stockFraction=1/(n*c.collarBottoms_m.length)
 same(collars.volume_m3,n*c.collarBottoms_m.length*collarVolume_m3,'existing whole collar volume')
 same(collars.mass_kg,collars.volume_m3*c.steelDensity_kg_m3,'existing whole collar mass')
 same(jacks.mass_kg,n*c.attachedJackMassPerCluster_kg,'existing whole jack mass')
 same(jacks.mass_kg,jacks.volume_m3*c.steelDensity_kg_m3,'existing whole jack density')
 const clusters=plan.motion.clusters.map((s,cluster)=>{
  const fitting=bind(plan.clusterFA[cluster]!+'/top-fitting','Zr',['Zr'])
  same(fitting.mass_kg,plan.d.handling.topFitting_kg,'actual FA top-fitting mass')
  same(fitting.mass_kg,fitting.volume_m3*plan.d.fuel.cladDensity_kg_m3,'actual FA top-fitting density')
  return {id:s.id,cluster,faId:plan.clusterFA[cluster]!,topFitting:fitting,
   upperCollar:{...collars,id:`HEAD.COLLARS/${s.id}/UPPER`,sourceStockId:collars.id,stockFraction,
    sliceVolume_m3:collarVolume_m3,sliceMass_kg:collarMass_kg,contactPlane_m:c.collarBottoms_m[1]!+c.collarHeight_m}}
 }),armature={mass_kg:c.gapArmature_kg,stroke_m:c.gapStroke_m,spring_n_m:c.gapSpring_N_m,damping_n_s_m:c.gapDamping_N_s_m},
  fields=[n,selection.lift_m,minimumStemPose_m,armature.mass_kg,armature.stroke_m,armature.spring_n_m,armature.damping_n_s_m,
   selection.maximumInertanceDensityRelativeDeparture,selection.movingImpactHeatFraction,
   ...jacks.targets,jacks.volume_m3,jacks.mass_kg]
 for(const q of clusters){const a=q.topFitting,b=q.upperCollar
  fields.push(a.targets[0]!,a.volume_m3,a.mass_kg,a.original_K,...b.targets,b.volume_m3,b.mass_kg,
   b.stockFraction,b.sliceMass_kg,b.original_K)
 }
 fields.push(shoulder.radius_m,shoulder.bottom_m,shoulder.top_m,broadDrag.body_area_m2,
  broadDrag.stem_area_m2,broadDrag.coefficient,selection.normalStop==='backdrivable-coast-to-hold'?1:0)
 if(fields.some(v=>!Number.isFinite(v)))throw Error('Nonfinite cold release physical frame')
 return {selection,minimumStemPose_m,armature,jacks,clusters,fields,neckInterfaces,shoulder,broadDrag,
  inertanceDensityOwner:'initial-admitted-native-UPPER-chart' as const,
  scope:'Prospective offline paid0.25m lift/release; actual52 top fittings and52 upper-collar impact increments, no new material/history. Actual shaft/shoulder plug geometry; fixed initial-owned-UPPER inertance density binds natively after admitted IC. Broad spider envelope disk and stub/lug drag use authored cold quiescent-UPPER Cd1.28, with half/twice held sensitivity; this is not a resolved porous-frame or local-throughflow field. Existing ordinary positive-burst control unchanged. Advancement not established by this compiler.'}
}

/** One current geometric view of the selected cold control motion. This owns
 * no neutron, isotope, fuel, liquid or thermal history. The full SOURCE and
 * cooling consumers retain their own histories and consume these same trial
 * coefficients. ORIGINAL preparation is split once; no reached stock is split.
 */
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {currentColdGeometry} from './reference-design-current-cold-parent'
import {axialIntervalOverlap,compileControlMaterialMotion,controlMaterialMotionAt,type ControlMaterialPose} from './reference-design-control-material-motion'
import {circleRectangleArcs} from './reference-design-source-faces'
import {diskRectangleArea,type SourceRegion} from './reference-design-source-partition'
import type {parsePrimaryWaterInputs} from './reference-design-source-water'
import type {compileFuelCooling} from './reference-design-fuel-cooling'
import type {compileOriginalPassiveGeometry} from './reference-design-source-passive'
import type {compileCylinderInputs} from './reference-design-source-cylinder'
import type {compileSourceEvolution} from './reference-design-source-evolution'
import {nativeAbsorberGuideFrame} from './reference-design-absorber-guide'
import {nativeMobileCaptureFrame} from './reference-design-mobile-capture'

type Input=ReturnType<typeof parsePrimaryWaterInputs>
type Cooling=Awaited<ReturnType<typeof compileFuelCooling>>
type Passive=ReturnType<typeof compileOriginalPassiveGeometry>
type Cylinder=ReturnType<typeof compileCylinderInputs>
type Side=ControlMaterialPose['side']
export type ControlSourcePose=ControlMaterialPose&{stem_y_m:number;stem_side:Side;contact:'seated'|'offseat'}
export type ControlSourceDirection={body:number;stem:number}
// A local directional scalar, not another physical or differentiation model.
// The physical clipping branch is selected by the pose, never by its JVP.
type D=readonly[number,number]
const C=(v:number):D=>[v,0],add=(a:D,b:D):D=>[a[0]+b[0],a[1]+b[1]],
   sub=(a:D,b:D):D=>[a[0]-b[0],a[1]-b[1]],
 scale=(a:D,b:number):D=>[a[0]*b,a[1]*b],div=(a:D,b:D):D=>[a[0]/b[0],(a[1]*b[0]-a[0]*b[1])/(b[0]*b[0])],
 sqrt=(a:D):D=>{const s=Math.sqrt(a[0]);return[s,a[1]/(2*s)]},sum=(a:readonly D[]):D=>a.reduce(add,C(0))
function close(a:number,b:number,label:string,scale=Math.max(Math.abs(a),Math.abs(b),1e-12)){
 if(!Number.isFinite(a+b)||Math.abs(a-b)>8e-10*scale)throw Error('Current control/source geometry: '+label+' '+a+' vs '+b)
}
function interval(lo:number,hi:number,bottom:number,top:number,y:D,side:Side){
 const v=axialIntervalOverlap(lo,hi,bottom,top,y[0],side==='increasing')
 return {length:[v[0],v[1]*y[1]] as D,moment:[v[2],v[3]*y[1]] as D}
}
const regionSpan=(r:SourceRegion,d:Input)=>r.compartment==='LOWER'
 ?{lo:d.handling.seatedBottom_m,hi:d.handling.seatedBottom_m+d.handling.bottomFittingLength_m}
 :r.compartment==='UPPER'?{lo:d.handling.seatedBottom_m+d.handling.bottomFittingLength_m+d.fuel.activeLength_m,hi:d.control.headBottom_m}
 :{lo:r.z0_m!,hi:r.z1_m!}
function circle(r:SourceRegion,x:number,y:number,radius:number){
 if(radius===0)return 0
 if(!r.box)return Math.PI*radius*radius
 const b=r.box
 if(b.x0>=x+radius||b.x1<=x-radius||b.y0>=y+radius||b.y1<=y-radius)return 0
 return diskRectangleArea(radius,{x0:b.x0-x,x1:b.x1-x,y0:b.y0-y,y1:b.y1-y})
}
type Stage=Cooling['mobileCapture']['wall_origins'][number]['paths'][number]['stages'][number]
type PathRole={kind:'fixed';area:number}|{kind:'side';cluster:number;material:'active'|'lower'|'upper';inside:boolean}
 |{kind:'end';cluster:number;end:'bottom'|'top';recipient:'LOWER'|'GUIDE'|'UPPER'}
type OriginPlan={id:string;kind:'fixed'|'lower'|'upper'|'guide'|'housing';cluster?:number;
 originalVolume:number;originalBoundary:number;paths:{role:PathRole;stages:Stage[]}[];radius?:number;length?:number}
type WaterPatch={region:number;cell:number;origin:string;original:number;
 guide?:{cluster:number;outerArea:number;bodyArea:number;lo:number;hi:number};
 housing?:{intruder:number;area:number;lo:number;hi:number}[]}
type Intruder={cluster:number;motion:'body'|'stem';lo:number;hi:number;area:number;
 radius?:number;inner?:number;upperOnly:boolean}

/** Prepare a fixed union and a single ORIGINAL owner split. All other native
 * liquid rows keep their relative order. `oldWaterToNew` never maps the old
 * pooled BODY to one of its children: callers must explicitly consume split. */
export function compileControlSourceMotion(d:Input,p:Cooling,passive:Passive,cylinder:Cylinder){
 const partition=p.material.partition,c=d.control,h=d.handling,f=d.fuel,
  cg=controlAbsorberGeometry(c,f,h),current=currentColdGeometry(c,d.attachment,f,h,d.gates,d.head,d.cold),
  motion=compileControlMaterialMotion(partition.regions,d,passive.stocks),
  oldBody=p.network.water.findIndex(w=>w.id==='GUIDE.BODY'),upperOld=p.network.water.findIndex(w=>w.id==='UPPER'),
  bottom=h.seatedBottom_m,top=current.faTop_m,L=top-bottom,N=c.rodletsPerCluster,
  ro=h.guideInnerDiameter_m/2,rb=c.bodyDiameter_m/2,ra=c.absorberDiameter_m/2,
  bodyA=N*Math.PI*rb*rb,guideA=N*Math.PI*ro*ro,annulus=guideA-bodyA,
  clusterFA=cg.sites.map(s=>partition.assemblies.find(fa=>fa.x_m===s.x_m&&fa.y_m===s.y_m)?.id),
  guideIds=motion.clusters.map(q=>'GUIDE.'+q.id),oldWaterToNew:(number|null)[]=[],water:Cooling['network']['water']=[]
 if(oldBody<0||upperOld<0||clusterFA.some(id=>!id)||cg.sites.length!==52||cylinder.targets.length!==53)
  throw Error('Missing complete cold control/source physical owners')
 for(const [i,w]of p.network.water.entries()){
  if(i===oldBody){oldWaterToNew.push(null);for(const id of guideIds)water.push({...w,id,
   volume_m3:w.volume_m3/c.clusters,owners:[id]})}
  else {oldWaterToNew.push(water.length);water.push({...w,owners:[...w.owners]})}
 }
 const old=(i:number)=>{const n=oldWaterToNew[i];if(n===undefined||n===null)throw Error('Pooled BODY owner needs explicit physical split');return n},
  guideCells=guideIds.map(id=>water.findIndex(w=>w.id===id)),upper=old(upperOld),
  lower=water.findIndex(w=>w.id==='LOWER'),
  allOriginal=water.reduce((s,w)=>s+w.volume_m3,0)
 close(allOriginal,p.network.water.reduce((s,w)=>s+w.volume_m3,0),'once-only initial liquid volume')
 for(const i of guideCells){close(water[i]!.volume_m3,annulus*L,'one actual cluster guide');
  close(water[i]!.elevation_m,(bottom+top)/2,'one actual guide mean')}
 const hydraulic=p.network.hydraulic.flatMap((e,index)=>{
  if(e.from!==oldBody&&e.to!==oldBody)return [{...e,from:old(e.from),to:old(e.to),original:index,cluster:null as number|null}]
  return guideCells.map((cell,cluster)=>({...e,id:e.id.replace('GUIDE.BODY',guideIds[cluster]!),
   from:e.from===oldBody?cell:old(e.from),to:e.to===oldBody?cell:old(e.to),original:index,cluster,
   segments:e.segments.map(s=>({...s,area_m2:s.area_m2/c.clusters})),
   basis:e.basis+'; ORIGINAL one-cluster split, actual moving hydraulics remain current-network-owned'}))
 })
 const originalBodyStocks=new Set(motion.rows.map(r=>r.stock)),passiveRows=[
  ...passive.nativeBulk.incidence.filter(r=>!originalBodyStocks.has(r.stock)).map(r=>({...r,geometryRow:-1})),
  ...motion.rows.map((r,geometryRow)=>({stock:r.stock,region:r.region,volume:0,geometryRow})),
 ],cylinderRows:{target:number;region:number;original:number;cluster:number;lo:number;hi:number;arc:number}[]=[]
 for(const e of cylinder.intersections)if(e.target===cylinder.converterTarget)
  cylinderRows.push({...e,original:e.share,cluster:-1,lo:0,hi:0,arc:0})
 for(const [cluster,site]of cg.sites.entries()){
  const target=cylinder.targets.findIndex(t=>t.id===motion.clusters[cluster]!.prefix+'/B4C/B10')
  if(target<0)throw Error('Current BODY cylinder target identity')
  for(const r of motion.rows.filter(r=>r.cluster===cluster&&passive.stocks[r.stock]!.material==='B4C')){
   const region=partition.regions[r.region]!,span=regionSpan(region,d),arc=cg.bodySites.reduce((a,pin)=>{
    if(!region.box)return a+2*Math.PI*ra
    const b=region.box,x=site.x_m+pin.x_m,y=site.y_m+pin.y_m
    return a+ra*circleRectangleArcs(ra,{x0:b.x0-x,x1:b.x1-x,y0:b.y0-y,y1:b.y1-y}).reduce((s,a)=>s+a.hi-a.lo,0)
   },0)
   if(arc>0)cylinderRows.push({target,region:r.region,original:0,cluster,lo:span.lo,hi:span.hi,arc})
  }
 }
 const patches:WaterPatch[]=p.primary.birthPatches.filter(q=>q.cell!==oldBody)
  .map(q=>({region:q.region,cell:old(q.cell),origin:q.origin,original:q.volume_m3})),
  guideRegions=partition.regions.map((r,region)=>({r,region})).filter(q=>['ACTIVE','LOWER','UPPER'].includes(q.r.compartment))
 for(const [cluster,site]of cg.sites.entries())for(const {r,region}of guideRegions){
  const span=regionSpan(r,d),lo=Math.max(bottom,span.lo),hi=Math.min(top,span.hi)
  if(hi<=lo)continue
  const areas=cg.bodySites.reduce((a,pin)=>({outer:a.outer+circle(r,site.x_m+pin.x_m,site.y_m+pin.y_m,ro),
   body:a.body+circle(r,site.x_m+pin.x_m,site.y_m+pin.y_m,rb)}),{outer:0,body:0})
  if(areas.outer>0)patches.push({region,cell:guideCells[cluster]!,origin:guideIds[cluster]!,
   original:(areas.outer-areas.body)*(hi-lo),guide:{cluster,outerArea:areas.outer,bodyArea:areas.body,lo,hi}})
 }
 patches.sort((a,b)=>a.region-b.region||a.cell-b.cell||a.origin.localeCompare(b.origin))
 const waterRows=[...new Map(patches.map(q=>[q.region+'/'+q.cell,{region:q.region,cell:q.cell}])).values()],
  rowIndex=new Map(waterRows.map((q,i)=>[q.region+'/'+q.cell,i])),
  intruders:Intruder[]=[]
 for(let cluster=0;cluster<c.clusters;cluster++)for(const q of current.intruders){
  if(q.shape==='rodlet'||q.motion==='fixed')continue
  const radial=q.shape==='annulus'?{radius:q.outer_m,inner:q.inner_m}:undefined
  intruders.push({cluster,motion:q.motion,lo:q.lo,hi:q.hi,area:q.area/c.clusters,
   ...radial,upperOnly:radial===undefined})
 }
 // This boundary refuses new passage/collision physics; it is not an accuracy
 // clamp. The current short burst is far inside it. No material is clipped to it.
 const maximumBodyPose_m=Math.min(c.normalTravel_m,c.headBottom_m-top,
  ...intruders.filter(q=>q.motion==='body'&&q.upperOnly).map(q=>c.headBottom_m-q.hi)),
  maximumStemPose_m=Math.min(c.normalTravel_m,c.neckTop_m-
   Math.max(...intruders.filter(q=>q.motion==='stem').map(q=>q.hi)),
   ...intruders.filter(q=>q.motion==='stem'&&q.upperOnly).map(q=>c.headBottom_m-q.hi))
 if(!(maximumBodyPose_m>0&&maximumStemPose_m>0))throw Error('No fully described cold motion domain')
 for(const patch of patches)if(patch.origin.startsWith('HOUSING.')){
  const r=partition.regions[patch.region]!,lo=Math.max(r.z0_m!,patch.origin==='HOUSING.MAIN'?c.headBottom_m:c.housingTop_m),
   hi=Math.min(r.z1_m!,patch.origin==='HOUSING.MAIN'?c.housingTop_m:c.neckTop_m)
  patch.housing=intruders.flatMap((q,intruder)=>{
   if(q.upperOnly||hi<=lo)return []
   const site=cg.sites[q.cluster]!,area=circle(r,site.x_m,site.y_m,q.radius!)-circle(r,site.x_m,site.y_m,q.inner!)
   return area>0?[{intruder,area,lo,hi}]:[]
  })
 }
 const contactPlans:{host:number;water:number;origin:string;role:'fixed'|'guide-side'|'upper-side'|'bottom-lower'|'bottom-guide'|'top-upper';
 cluster:number;area:number;solid:number}[]=[]
 for(const [host,entry]of p.absorberGuide.hosts.entries()){
  const cluster=clusterFA.indexOf(entry.faId)
  if(entry.kind==='body'){
   if(cluster<0)throw Error('BODY thermal/source cluster identity')
   for(const q of [
    {water:guideCells[cluster]!,origin:guideIds[cluster]!,role:'guide-side' as const},
    {water:upper,origin:'UPPER.EXTERNAL',role:'upper-side' as const},
    {water:lower,origin:'LOWER.EXTERNAL',role:'bottom-lower' as const},
    {water:guideCells[cluster]!,origin:guideIds[cluster]!,role:'bottom-guide' as const},
    {water:upper,origin:'UPPER.EXTERNAL',role:'top-upper' as const},
   ])contactPlans.push({host,...q,cluster,area:0,solid:0})
  }else for(const q of entry.contacts){
   const split=q.water===oldBody
   if(split&&cluster<0)throw Error('Stationary guide has no physical current cluster')
   contactPlans.push({host,water:split?guideCells[cluster]!:old(q.water),origin:split?guideIds[cluster]!:q.origin,
    role:'fixed',cluster,area:q.area_m2,solid:q.solid_geometry_m_inv})
  }
 }
 const oldEnvelopes=new Map(p.mobileCapture.envelopes.map(e=>[e.origin,e])),bodyHosts=new Map(p.absorberGuide.hosts
  .map((h,i)=>({h,i})).filter(q=>q.h.kind==='body').map(q=>[clusterFA.indexOf(q.h.faId),q.i])),
  shell=rb-ra,activeLength=c.activeLength_m,lowerCap=c.insertedActiveBottom_m-bottom,
  upperCap=top-c.insertedActiveBottom_m-activeLength,
  steelMu=p.mobileCapture.wall_origins.flatMap(o=>o.paths).flatMap(p=>p.stages).find(s=>s.kind===2
   &&p.absorberGuide.hosts[s.recipient_index]?.kind==='body'&&s.density_kg_m3===p.absorberGuide.photon.density_steel)?.mu
 const guideMu=p.mobileCapture.wall_origins.flatMap(o=>o.paths).flatMap(path=>path.stages).find(s=>s.kind===2
  &&p.absorberGuide.hosts[s.recipient_index]?.kind==='guide'&&s.density_kg_m3===p.absorberGuide.photon.density_zr)?.mu
 if(!steelMu||!guideMu||!(lowerCap>0&&upperCap>0))throw Error('Missing actual BODY/guide serial photon law')
 const wall=(cluster:number,material:'active'|'lower'|'upper'):Stage[]=>{
  const host=bodyHosts.get(cluster)!,s:Stage={kind:2,recipient_index:host,thickness_m:shell,
   density_kg_m3:p.absorberGuide.photon.density_steel,mu:[...steelMu]}
  if(material==='active')return[s,{kind:2,recipient_index:host,
   thickness_m:2*ra*activeLength/(activeLength+ra),density_kg_m3:p.absorberGuide.photon.density_b4c,
   mu:[p.absorberGuide.photon.mu_b4c_05,p.absorberGuide.photon.mu_b4c_1]},s]
  const length=material==='lower'?lowerCap:upperCap
  return[{...s,thickness_m:2*rb*length/(length+rb)}]
 },origins:OriginPlan[]=[]
 for(const o of p.mobileCapture.wall_origins){
  if(o.id==='GUIDE.BODY'){
   for(let cluster=0;cluster<c.clusters;cluster++){
    const guideHosts=p.absorberGuide.hosts.map((h,host)=>({h,host})).filter(q=>q.h.kind==='guide'
     &&q.h.bore==='BODY'&&q.h.faId===clusterFA[cluster]),paths:OriginPlan['paths']=[]
    for(const {h,host}of guideHosts){const contact=h.contacts.find(q=>q.origin==='GUIDE.BODY')!
     paths.push({role:{kind:'fixed',area:contact.area_m2},stages:[{kind:2,recipient_index:host,
      thickness_m:h.outer_m-h.inner_m,density_kg_m3:p.absorberGuide.photon.density_zr,
      mu:[...guideMu]}]})}
    for(const material of ['active','lower','upper'] as const)paths.push({role:{kind:'side',cluster,material,inside:true},stages:wall(cluster,material)})
    paths.push({role:{kind:'end',cluster,end:'bottom',recipient:'GUIDE'},stages:wall(cluster,'lower')})
    origins.push({id:guideIds[cluster]!,kind:'guide',cluster,originalVolume:annulus*L,
     originalBoundary:N*2*Math.PI*(ro+rb)*L+2*annulus,paths})
   }
  }else {
   const key=o.id==='ACTIVE.EXTERNAL'?'Core.1.EXTERNAL':o.id,e=oldEnvelopes.get(key)
   if(!e)throw Error('Missing immutable physical photon envelope '+o.id)
   const kind=o.id==='LOWER.EXTERNAL'?'lower':o.id==='UPPER.EXTERNAL'?'upper':o.id.startsWith('HOUSING.')?'housing':'fixed',
    paths:OriginPlan['paths']=o.paths.filter(path=>!path.stages.some(s=>s.kind===2&&p.absorberGuide.hosts[s.recipient_index]?.kind==='body'))
     .map(path=>({role:{kind:'fixed' as const,area:path.share*e.boundary_m2},stages:path.stages.map(s=>({...s,mu:[...s.mu] as [number,number]}))}))
   if(kind==='lower'||kind==='upper')for(let cluster=0;cluster<c.clusters;cluster++){
    if(kind==='upper')for(const material of ['active','lower','upper'] as const)
     paths.push({role:{kind:'side',cluster,material,inside:false},stages:wall(cluster,material)})
    paths.push({role:{kind:'end',cluster,end:kind==='lower'?'bottom':'top',recipient:kind==='lower'?'LOWER':'UPPER'},
     stages:wall(cluster,kind==='lower'?'lower':'upper')})
   }
   origins.push({id:o.id,kind,originalVolume:e.volume_m3,originalBoundary:e.boundary_m2,paths,
    ...(kind==='housing'?{radius:(o.id==='HOUSING.MAIN'?c.housingID_m:c.neckID_m)/2,
     length:o.id==='HOUSING.MAIN'?current.housing.mainHi-current.housing.mainLo:current.housing.neckHi-current.housing.mainHi}:{})})
  }
 }
 const originIndexes=new Map(origins.map((o,i)=>[o.id,i])),routes=patches.map((q,i)=>({region:q.region,water:q.cell,
  wall_origin:originIndexes.get(q.origin.startsWith('Core.')?'ACTIVE.EXTERNAL':q.origin)!,patch:i,row:rowIndex.get(q.region+'/'+q.cell)!}))
 if(routes.some(q=>q.wall_origin===undefined))throw Error('Current birth route has no physical photon origin')
 return {d,partition,motion,water,oldWaterToNew,oldPooledBody:oldBody,guideCells,guideIds,clusterFA,
  hydraulic,upper,lower,passiveRows,cylinderRows,patches,waterRows,contactPlans,origins,routes,intruders,
  maximumBodyPose_m,maximumStemPose_m,bottom,top,activeTop:h.seatedBottom_m+h.bottomFittingLength_m+f.activeLength_m,guideA,bodyA,annulus,
  immutable:{stockIds:passive.stocks.map(s=>s.id),targetIds:cylinder.targets.map(t=>t.id),
   hostIds:p.absorberGuide.hosts.map(h=>h.id),regionIds:partition.regions.map(r=>r.id)},
  scope:'Current cold fullywet control geometry/source and thermal coefficients only. No source or coolant advancement, accepted trajectory, neutronic stem/spider/apparatus material closure, hot/phase motion or live installation.'}
}
export type ControlSourceMotion=ReturnType<typeof compileControlSourceMotion>

/** Evaluate once at an explicit attained pose/physical contact branch. Signed
 * derivatives use exactly that branch and immutable row/recipient identities.
 * No state vector is supplied, so this operation cannot reset an owned history. */
export function controlSourceMotionAt(plan:ControlSourceMotion,poses:readonly ControlSourcePose[],
 directions:readonly ControlSourceDirection[]=poses.map(()=>({body:0,stem:0}))){
 const {d}=plan,c=d.control,N=c.rodletsPerCluster,ro=d.handling.guideInnerDiameter_m/2,rb=c.bodyDiameter_m/2,
  L=plan.top-plan.bottom,bodyV=controlMaterialMotionAt(plan.motion,poses),
  body=poses.map((p,i):D=>[p.body_y_m,directions[i]?.body??NaN]),stem=poses.map((p,i):D=>[p.stem_y_m,directions[i]?.stem??NaN])
 if(directions.length!==poses.length||poses.some((p,i)=>!Number.isFinite(p.stem_y_m+body[i]![1]+stem[i]![1])
  ||p.body_y_m>plan.maximumBodyPose_m||p.stem_y_m<0||p.stem_y_m>plan.maximumStemPose_m
  ||!['increasing','decreasing'].includes(p.stem_side)||(p.stem_y_m===0&&p.stem_side==='decreasing')
  ||!['seated','offseat'].includes(p.contact)||(p.contact==='seated'&&p.body_y_m!==0)))
  throw Error('Current control/source pose outside described cold contact/passage domain')
 const material=plan.passiveRows.map(r=>r.geometryRow<0?C(r.volume):[
  bodyV[4*r.geometryRow]!,bodyV[4*r.geometryRow+1]!*directions[plan.motion.rows[r.geometryRow]!.cluster]!.body] as D),
  cylinders=plan.cylinderRows.map(r=>r.cluster<0?C(r.original):scale(interval(c.insertedActiveBottom_m,
   c.insertedActiveBottom_m+c.activeLength_m,r.lo,r.hi,body[r.cluster]!,poses[r.cluster]!.side).length,
   r.arc/(N*2*Math.PI*(c.absorberDiameter_m/2)*c.activeLength_m))),
  water=plan.water.map(w=>({V:C(w.volume_m3),J:C(w.volume_m3*w.elevation_m)})),
  originChanges=new Map<string,{V:D;J:D}>(['UPPER.EXTERNAL','HOUSING.MAIN','HOUSING.NECK'].map(id=>[id,{V:C(0),J:C(0)}]))
 const cut=(q:Intruder,lo:number,hi:number,current:boolean)=>interval(q.lo,q.hi,lo,hi,
  current?(q.motion==='body'?body[q.cluster]!:stem[q.cluster]!):C(0),q.motion==='body'?poses[q.cluster]!.side:poses[q.cluster]!.stem_side)
 for(const [cluster,p]of poses.entries()){
  const filled=interval(plan.bottom,plan.top,plan.bottom,plan.top,body[cluster]!,p.side),
   cell=plan.guideCells[cluster]!,V=sub(C(plan.guideA*L),scale(filled.length,plan.bodyA)),
   J=sub(C(plan.guideA*(plan.top**2-plan.bottom**2)/2),scale(filled.moment,plan.bodyA))
  water[cell]={V,J}
  const exposed=interval(plan.bottom,plan.top,plan.top,c.headBottom_m,body[cluster]!,p.side),
   change=originChanges.get('UPPER.EXTERNAL')!
  change.V=sub(change.V,scale(exposed.length,plan.bodyA));change.J=sub(change.J,scale(exposed.moment,plan.bodyA))
 }
 for(const q of plan.intruders)for(const [id,lo,hi]of [['UPPER.EXTERNAL',plan.activeTop,c.headBottom_m],
  ['HOUSING.MAIN',c.headBottom_m,c.housingTop_m],['HOUSING.NECK',c.housingTop_m,c.neckTop_m]] as const){
  const a=cut(q,lo,hi,true),b=cut(q,lo,hi,false),change=originChanges.get(id)!
  change.V=sub(change.V,scale(sub(a.length,b.length),q.area));change.J=sub(change.J,scale(sub(a.moment,b.moment),q.area))
 }
 water[plan.upper]={V:add(water[plan.upper]!.V,sum([...originChanges.values()].map(q=>q.V))),
  J:add(water[plan.upper]!.J,sum([...originChanges.values()].map(q=>q.J)))}
 const patchValues=plan.patches.map(q=>{
  if(q.guide){const g=q.guide,filled=interval(plan.bottom,plan.top,g.lo,g.hi,body[g.cluster]!,poses[g.cluster]!.side)
   return sub(C(g.outerArea*(g.hi-g.lo)),scale(filled.length,g.bodyArea))}
  if(q.origin==='UPPER.EXTERNAL')return add(C(q.original),originChanges.get(q.origin)!.V)
  if(!q.origin.startsWith('HOUSING.'))return C(q.original)
  let delta=C(0)
  for(const clip of q.housing!){
   const intruder=plan.intruders[clip.intruder]!,a=cut(intruder,clip.lo,clip.hi,true),b=cut(intruder,clip.lo,clip.hi,false)
   delta=sub(delta,scale(sub(a.length,b.length),clip.area))
  }
  return add(C(q.original),delta)
 }),rowVolumes=plan.waterRows.map(()=>C(0))
 for(const [i,q]of plan.routes.entries())rowVolumes[q.row]=add(rowVolumes[q.row]!,patchValues[i]!)
 const envelope=plan.origins.map(o=>{
   if(o.kind==='guide'){
    const k=o.cluster!,y=body[k]!,off=poses[k]!.contact==='offseat',V=water[plan.guideCells[k]!]!.V,
     occupied=sub(C(L),y),ends=off?2*plan.guideA:2*plan.annulus,
     A=add(C(N*2*Math.PI*ro*L+ends),scale(occupied,N*2*Math.PI*rb))
    return {V,A,chord:div(scale(V,4),A)}
   }
   const change=originChanges.get(o.id),V=change?add(C(o.originalVolume),change.V):C(o.originalVolume)
   let A=C(o.originalBoundary)
   if(o.kind==='lower')A=sub(A,C(plan.bodyA*poses.filter(p=>p.contact==='offseat').length))
   if(o.kind==='upper')A=add(A,scale(sum(body),N*2*Math.PI*rb))
   if(o.kind==='housing'){
    const length=o.length!,radius=o.radius!,ri=sqrt(sub(C(radius*radius),scale(V,1/(c.clusters*Math.PI*length))))
    A=add(scale(add(C(radius),ri),c.clusters*2*Math.PI*length),scale(V,2/length))
   }
   return {V,A,chord:div(scale(V,4),A)}
  }),pathArea=(role:PathRole):D=>{
   if(role.kind==='fixed')return C(role.area)
   const k=role.cluster,p=poses[k]!
   if(role.kind==='end')return C(role.end==='top'?(role.recipient==='UPPER'?plan.bodyA:0):
    role.recipient==='LOWER'?(p.contact==='seated'?plan.bodyA:0):role.recipient==='GUIDE'?(p.contact==='offseat'?plan.bodyA:0):0)
   const spans={active:[c.insertedActiveBottom_m,c.insertedActiveBottom_m+c.activeLength_m],
    lower:[plan.bottom,c.insertedActiveBottom_m],upper:[c.insertedActiveBottom_m+c.activeLength_m,plan.top]} as const,
    [lo,hi]=spans[role.material],
    // Evaluate the actual recipient intersection directly. A full-minus-inside
    // subtraction can fabricate a negative exposed area for a wholly enclosed
    // translated piece because its two endpoints round independently.
    length=role.inside?interval(lo,hi,plan.bottom,plan.top,body[k]!,p.side).length:
     interval(lo,hi,plan.top,c.headBottom_m,body[k]!,p.side).length
   return scale(length,N*2*Math.PI*rb)
  },pathShares=plan.origins.flatMap((o,i)=>o.paths.map(path=>div(pathArea(path.role),envelope[i]!.A))),
  boundaryShares=plan.origins.map((o,i)=>sub(C(1),sum(o.paths.map(path=>div(pathArea(path.role),envelope[i]!.A))))),
  originIndex=new Map(plan.origins.map((o,i)=>[o.id,i])),contacts=plan.contactPlans.map(q=>{
   let area=C(q.area)
   if(q.role!=='fixed'){
    const k=q.cluster,p=poses[k]!
    area=q.role==='guide-side'?scale(sub(C(L),body[k]!),N*2*Math.PI*rb):
     q.role==='upper-side'?scale(body[k]!,N*2*Math.PI*rb):
     C(q.role==='top-upper'?plan.bodyA:q.role==='bottom-lower'?(p.contact==='seated'?plan.bodyA:0):(p.contact==='offseat'?plan.bodyA:0))
   }
   const origin=q.origin.startsWith('Core.')?'ACTIVE.EXTERNAL':q.origin,index=originIndex.get(origin)
   if(index===undefined)throw Error('Current thermal contact has no photon origin')
   return {area,solid:C(q.solid),chord:envelope[index]!.chord}
  }),birthShares=plan.routes.map((q,i)=>div(patchValues[i]!,rowVolumes[q.row]!)),
  liquidChords=plan.routes.map(q=>envelope[q.wall_origin]!.chord),
  wallThickness=plan.origins.flatMap(o=>o.paths.flatMap(path=>path.stages.map(w=>C(w.thickness_m))))
 if([...water.flatMap(q=>[q.V,q.J]),...material,...cylinders,...rowVolumes,...birthShares,
  ...liquidChords,...pathShares,...boundaryShares,...contacts.flatMap(q=>[q.area,q.solid,q.chord])].some(q=>!q.every(Number.isFinite))
  ||water.some(q=>q.V[0]<=0)||rowVolumes.some(q=>q[0]<=0)
  ||rowVolumes.some((q,i)=>q[0]>water[plan.waterRows[i]!.cell]!.V[0])
  ||[...pathShares,...birthShares,...boundaryShares].some(q=>q[0]<0||q[0]>1))
  throw Error('Current control/source geometric admission failed')
 const values=(a:readonly D[])=>a.map(q=>q[0]),derivatives=(a:readonly D[])=>a.map(q=>q[1]),
  source={passiveVolumes:values(material),cylinderShares:values(cylinders),moderatorVolumes:values(rowVolumes),externalWaterVolumes:water.map(q=>q.V[0])},
  sourceDirection={passiveVolumes:derivatives(material),cylinderShares:derivatives(cylinders),moderatorVolumes:derivatives(rowVolumes),externalWaterVolumes:water.map(q=>q.V[1])},
  mobile=(direction:boolean)=>({birth_shares:direction?derivatives(birthShares):values(birthShares),
   liquid_chords_m:direction?derivatives(liquidChords):values(liquidChords),
   path_shares:direction?derivatives(pathShares):values(pathShares),wall_thicknesses_m:direction?derivatives(wallThickness):values(wallThickness),
   boundary_shares:direction?derivatives(boundaryShares):values(boundaryShares)})
 return {source,sourceDirection,mobile:mobile(false),mobileDirection:mobile(true),
  contacts:contacts.map(q=>({area_m2:q.area[0],solid_geometry_m_inv:q.solid[0],liquid_chord_m:q.chord[0]})),
  contactDirection:contacts.map(q=>({area_m2:q.area[1],solid_geometry_m_inv:q.solid[1],liquid_chord_m:q.chord[1]})),
  water:water.map(q=>({volume_m3:q.V[0],moment_m4:q.J[0]})),
  waterDirection:water.map(q=>({volume_m3:q.V[1],moment_m4:q.J[1]})),
  envelope:envelope.map((e,i)=>({id:plan.origins[i]!.id,volume_m3:e.V[0],boundary_m2:e.A[0],chord_m:e.chord[0]})),
  patchVolumes:values(patchValues),materialMoments:plan.motion.rows.map((r,i)=>({stock:r.stock,region:r.region,V:bodyV[4*i]!,J:bodyV[4*i+2]!})),
  scope:plan.scope}
}

export type ControlSourceStage=ReturnType<typeof controlSourceMotionAt>
/** One strict internal numeric stage: source, finite BODY/guide contacts,
 * mobile-photon geometry and native-liquid V/J; then the same signed shape.
 * This supplies coefficients only, never an initialized/rebuilt SOURCE. */
export function nativeControlSourceStage(stage:ControlSourceStage){
 if([stage.source.cylinderShares,stage.mobile.birth_shares,
  stage.mobile.path_shares,stage.mobile.boundary_shares].some(a=>a.some(v=>v<0||v>1)))
  throw Error('Current SOURCE native value probabilities outside [0,1]')
 const fields:number[]=[],array=(a:readonly number[])=>fields.push(a.length,...a)
 for(const direction of [false,true]){
  const source=direction?stage.sourceDirection:stage.source,
   contacts=direction?stage.contactDirection:stage.contacts,mobile=direction?stage.mobileDirection:stage.mobile,
   water=direction?stage.waterDirection:stage.water
  if(source.externalWaterVolumes.length!==water.length
   ||source.externalWaterVolumes.some((v,i)=>!Object.is(v,water[i]!.volume_m3))
   ||(!direction&&source.externalWaterVolumes.some(v=>!(v>0))))
   throw Error('Current SOURCE bulk-volume authority differs from finite water geometry')
  for(const a of [source.passiveVolumes,source.cylinderShares,source.moderatorVolumes])array(a)
  fields.push(contacts.length,...contacts.flatMap(c=>[c.area_m2,c.solid_geometry_m_inv,c.liquid_chord_m]))
  for(const a of [mobile.birth_shares,mobile.liquid_chords_m,mobile.path_shares,mobile.wall_thicknesses_m,mobile.boundary_shares])array(a)
  fields.push(water.length,...water.flatMap(w=>[w.volume_m3,w.moment_m4]))
 }
 if(fields.some(q=>!Number.isFinite(q)))throw Error('Nonfinite current SOURCE stage frame')
 return fields
}

/** Prepare the existing SOURCE exactly once with the current-incidence union
 * and the once-only ORIGINAL guide-water split. Cases are unaccepted numeric
 * stage evaluations with unchanged SOURCE history, not trajectory admission.
 * The native probe retains one Model across all frames, including restoration. */
export function nativeControlSourceFixture(plan:ControlSourceMotion,source:ReturnType<typeof compileSourceEvolution>,
 p:Cooling,cases:readonly ControlSourceStage[]){
 const same=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((id,i)=>id===b[i]),
  original=source.material.materialPayload,
  identities=source.material.nativeInputs.fuel.identities
 if(!same(identities.regions,plan.immutable.regionIds)
  ||!same(original.passive.stocks.map(s=>s.id),plan.immutable.stockIds)
  ||!same(original.cylinder.targets.map(t=>t.id),plan.immutable.targetIds)
  ||!same(identities.cohorts,p.material.result.cohorts.filter(c=>c.material==='fuel').map(c=>c.id)))
  throw Error('Current SOURCE fixture physical identity/order mismatch')
 const poses:ControlSourcePose[]=plan.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,
  side:'increasing',stem_side:'increasing',contact:'seated'})),originalStage=controlSourceMotionAt(plan,poses),
  closed=source.material.materialPayload.receiving.nativeOwners.map(o=>{
   const i=source.projection.owners.findIndex(p=>p.id===o.owner)
   if(i<0)throw Error('Current SOURCE fixture missing closed receiving owner');return i
  }),anchor=p.network.anchor,cladRows:number[]=[]
 let thermalRow=0
 for(const band of p.thermal.bands){thermalRow+=band.fuel_masses_kg.length
  for(let i=0;i<band.clad_masses_kg.length;i++)cladRows.push(thermalRow++)}
 if(new Set(closed).size!==closed.length||thermalRow+p.thermal.helium.length!==p.thermal.thermalCoordinates)
  throw Error('Current SOURCE fixture physical identity/order mismatch')
 const metadata=[anchor.pressure_Pa,anchor.temperature_K,anchor.elevation_m,
  p.primary.hydrogenAtomsPerKg,p.primary.boronAtomsPerKg,closed.length,...closed,
  plan.water.length,...plan.water.flatMap((w,i)=>[originalStage.water[i]!.volume_m3,originalStage.water[i]!.moment_m4,w.temperature_K,w.markerRatio]),
  plan.passiveRows.length,...plan.passiveRows.flatMap((r,i)=>[r.stock,r.region,originalStage.source.passiveVolumes[i]!]),
  plan.cylinderRows.length,...plan.cylinderRows.flatMap((r,i)=>[r.target,r.region,originalStage.source.cylinderShares[i]!]),
  plan.waterRows.length,...plan.waterRows.flatMap((r,i)=>[r.region,r.cell,originalStage.source.moderatorVolumes[i]!]),
  p.thermal.thermalCoordinates,cladRows.length,...cladRows],
  contacts=plan.contactPlans.map((c,i)=>({host:c.host,water:c.water,...originalStage.contacts[i]!})),
  absorber=nativeAbsorberGuideFrame(p.absorberGuide,source,p.mobileCapture,contacts),
  wallOrigins=plan.origins.map((o,i)=>({unrepresented_wall_share:originalStage.mobile.boundary_shares[i]!,paths:o.paths.map(path=>({
   share:0,stages:path.stages.map(s=>({...s,mu:[...s.mu] as [number,number]}))}))}))
 let path=0,wall=0
 for(const o of wallOrigins)for(const p of o.paths){p.share=originalStage.mobile.path_shares[path++]!
  for(const s of p.stages)s.thickness_m=originalStage.mobile.wall_thicknesses_m[wall++]!}
 const mobile=nativeMobileCaptureFrame({water_mu:p.mobileCapture.water_mu,wall_origins:wallOrigins,
  routes:plan.routes.map((r,i)=>({region:r.region,water:r.water,wall_origin:r.wall_origin,
   birth_share:originalStage.mobile.birth_shares[i]!,liquid_chord_m:originalStage.mobile.liquid_chords_m[i]!}))}),
  frame=(s:string)=>{const tokens=s.trim().split(/\s+/);return[tokens.length,...tokens].join('\n')},
  fields=[source.fixture,metadata.join('\n'),absorber.fields.join('\n'),mobile.join('\n'),
   nativeControlSourceStage(originalStage).join('\n'),[cases.length,...cases.flatMap(nativeControlSourceStage)].join('\n')]
 if([...metadata,...absorber.fields,...mobile].some(q=>!Number.isFinite(q)))throw Error('Nonfinite current SOURCE preparation')
 return fields.map(frame).join('\n')+'\n'
}

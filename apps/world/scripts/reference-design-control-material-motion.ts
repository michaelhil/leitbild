/** Offline BODY material-incidence prerequisite, not a moving source solver.
 * Immutable transverse clips are prepared once. Actual per-cluster axial poses
 * change only intersections; no target, product, thermal or neutron state is
 * prepared, normalized or copied here. */
import {controlBodyPrimitives, type PassiveStock} from './reference-design-source-passive'
import {diskRectangleArea, type SourceRegion} from './reference-design-source-partition'

type Inputs=Parameters<typeof controlBodyPrimitives>[0]&{primary:{downcomerBottom_m:number}}
export type ControlMaterialPose={clusterId:string,body_y_m:number,side:'increasing'|'decreasing'}
type Span={lo:number,hi:number,area:number}
export type ControlMaterialMotion=ReturnType<typeof compileControlMaterialMotion>

export function compileControlMaterialMotion(regions:readonly SourceRegion[],d:Inputs,stocks:readonly PassiveStock[]){
 const {geometry,rows:primitives}=controlBodyPrimitives(d),maximumTravel_m=d.control.normalTravel_m,
  activeBottom=d.handling.seatedBottom_m+d.handling.bottomFittingLength_m,activeTop=activeBottom+d.fuel.activeLength_m,
  regionIds=new Set(regions.map(r=>r.id)),stockIndexes=new Map(stocks.map((s,i)=>[s.id,i]))
 if(regionIds.size!==regions.length||stockIndexes.size!==stocks.length)throw Error('Duplicate physical source/material identity')
 const clusters=geometry.sites.map((s,i)=>({id:`LD01.CR.${String(i+1).padStart(3,'0')}`,prefix:`CONTROL/${s.x}/${s.y}`})),
  rows:{cluster:number,stock:number,region:number,lo:number,hi:number,spans:Span[]}[]=[],
  byStock=new Map<string,{cluster:number,primitives:typeof primitives}>()
 for(const [cluster,c] of clusters.entries())for(const suffix of ['/B4C','/STEEL']){
  const id=c.prefix+suffix,index=stockIndexes.get(id),pieces=primitives.filter(p=>p.stockId===id)
  if(index===undefined||pieces.length===0)throw Error('Missing moving BODY stock '+id)
  const stock=stocks[index]!,volume=pieces.reduce((v,p)=>{
   if(p.shape.kind!=='annulus'||p.scale!==1)throw Error('Unselected moving BODY shape')
   return v+Math.PI*(p.shape.outer**2-p.shape.inner**2)*(p.hi-p.lo)
  },0)
  if(!Number.isFinite(stock.volume_m3)||stock.volume_m3<=0
   ||stock.material!==(suffix==='/B4C'?'B4C':'steel304')
   ||Math.abs(volume-stock.volume_m3)>4e-10*stock.volume_m3)throw Error('BODY original volume mismatch '+id)
  byStock.set(id,{cluster,primitives:pieces})
 }
 for(const [stockId,body] of byStock)for(const [region,r] of regions.entries()){
  if(!['ACTIVE','LOWER','UPPER','WELL'].includes(r.compartment))continue
  const lo=r.id==='LOWER'?d.primary.downcomerBottom_m:r.id==='UPPER'?activeTop:r.z0_m,
   hi=r.id==='LOWER'?activeBottom:r.id==='UPPER'?d.control.headBottom_m:r.z1_m
  if(lo===undefined||hi===undefined||!Number.isFinite(lo+hi)||hi<=lo)throw Error('Missing physical source axial support '+r.id)
  const spans:Span[]=[]
  for(const p of body.primitives){
   if(p.hi+maximumTravel_m<=lo||p.lo>=hi)continue
   const s=p.shape
   if(s.kind!=='annulus')throw Error('Unselected moving BODY shape')
   const circle=(radius:number)=>{
    if(radius===0)return 0
    if(!r.box)return Math.PI*radius**2
    if(r.box.x1<=s.x-radius||r.box.x0>=s.x+radius||r.box.y1<=s.y-radius||r.box.y0>=s.y+radius)return 0
    return diskRectangleArea(radius,{x0:r.box.x0-s.x,x1:r.box.x1-s.x,y0:r.box.y0-s.y,y1:r.box.y1-s.y})
   }
   const area=circle(s.outer)-circle(s.inner)
   if(!Number.isFinite(area)||area<0)throw Error('Nonpositive moving material clip '+stockId+' '+r.id)
   if(area>0)spans.push({lo:p.lo,hi:p.hi,area})
  }
  // This union stays fixed through motion, including currently empty rows.
  if(spans.length)rows.push({cluster:body.cluster,stock:stockIndexes.get(stockId)!,region,lo,hi,spans})
 }
 const coverage=new Set(rows.map(r=>r.stock))
 if(coverage.size!==2*clusters.length)throw Error('Missing moving stock coverage')
 // Coverage is piecewise linear in pose. Check every clipping breakpoint,
 // not merely the presence of a stock or its ORIGINAL intersection. The first
 // moment is quadratic between breakpoints; its derivative must also match
 // one rigid translation. No material is normalized into a missing region.
 for(const [stockId,body] of byStock){
  const local=rows.filter(r=>r.stock===stockIndexes.get(stockId)),stock=stocks[stockIndexes.get(stockId)!]!,
   cuts=new Set([0,maximumTravel_m]),originalJ=body.primitives.reduce((J,p)=>{
    if(p.shape.kind!=='annulus')throw Error('Unselected moving BODY shape')
    return J+Math.PI*(p.shape.outer**2-p.shape.inner**2)*(p.hi-p.lo)*(p.hi+p.lo)/2
   },0)
  for(const r of local)for(const s of r.spans)for(const y of [r.lo-s.lo,r.lo-s.hi,r.hi-s.lo,r.hi-s.hi])
   if(y>0&&y<maximumTravel_m)cuts.add(y)
  const sorted=[...cuts].sort((a,b)=>a-b),probes=[...sorted,...sorted.slice(1).map((y,i)=>(y+sorted[i]!)/2)]
  for(const y of probes){let V=0,J=0,dV=0,dJ=0
   for(const r of local)for(const s of r.spans){const v=clip(s,r,y,true)
    V+=v[0];dV+=v[1];J+=v[2];dJ+=v[3]
   }
   const scale=stock.volume_m3,tolerance=4e-10*scale,
    expectedJ=originalJ+scale*y,lengthScale=Math.max(1,...body.primitives.map(p=>Math.abs(p.lo)+Math.abs(p.hi)),maximumTravel_m)
   if(Math.abs(V-scale)>tolerance||Math.abs(J-expectedJ)>tolerance*lengthScale
    ||(y<maximumTravel_m&&(Math.abs(dV)>tolerance||Math.abs(dJ-scale)>tolerance)))
    throw Error('Incomplete moving BODY source coverage '+stockId+' at '+y)
  }
 }
 return {clusters,rows,maximumTravel_m,stockIds:stocks.map(s=>s.id),regionIds:regions.map(r=>r.id),
  scope:'BODY B4C/steel geometry only. Not coupled moderator, stem/spider, contact/heat, source response or attained motion.'}
}

function clip(s:Span,r:{lo:number,hi:number},y:number,right:boolean){
 const a=s.lo+y,b=s.hi+y,L=Math.max(a,r.lo),U=Math.min(b,r.hi)
 if(U<L)return [0,0,0,0] as const
 const dl=a>r.lo?1:a<r.lo?0:right?1:0,du=b<r.hi?1:b>r.hi?0:right?0:1,
  length=U-L,raw=du-dl,dlength=length>0?raw:right?Math.max(0,raw):Math.min(0,raw)
 return [s.area*length,s.area*dlength,s.area*length*(U+L)/2,
  s.area*(length>0?U*du-L*dl:L*dlength)] as const
}

/** Fixed branch partials of clipped moving intervals. At a physical plane,
 * choose the one-sided branch ONCE for the stage; do not switch it per JVP
 * direction. Returns V, dV/dy, first vertical moment J, dJ/dy. */
export function controlMaterialMotionAt(plan:ControlMaterialMotion,poses:readonly ControlMaterialPose[]){
 if(poses.length!==plan.clusters.length)throw Error('Moving cluster pose coverage')
 for(const [i,p] of poses.entries())if(p.clusterId!==plan.clusters[i]!.id||!Number.isFinite(p.body_y_m)
  ||p.body_y_m<0||p.body_y_m>plan.maximumTravel_m||!['increasing','decreasing'].includes(p.side)
  ||(p.body_y_m===0&&p.side==='decreasing')||(p.body_y_m===plan.maximumTravel_m&&p.side==='increasing'))
  throw Error('Invalid or reordered moving cluster pose')
 const values=new Float64Array(plan.rows.length*4)
 for(const [i,r] of plan.rows.entries()){
  const p=poses[r.cluster]!,y=p.body_y_m,right=p.side==='increasing'
  for(const s of r.spans){
   const v=clip(s,r,y,right)
   for(let k=0;k<4;k++)values[4*i+k]!+=v[k]!
  }
 }
 if(values.some(v=>!Number.isFinite(v)))throw Error('Unrepresentable moving BODY incidence')
 return values
}

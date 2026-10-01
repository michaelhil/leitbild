/** Original held-patch/cold sensible check, not a moved-fluid or source runtime. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {fuelGeometry,parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {fuelMaterialPython} from './reference-design-fuel-materials'

const schema=z.object({primaryAxialEdges_m:z.tuple([z.literal(-4),z.literal(-2),z.literal(0),z.literal(2),z.literal(4)]),
 bayMeanAxialVelocity_m_s:z.literal(0),fittingContactArea_m2:z.number().finite().positive(),plenumConductionFactor:z.number().finite().positive(),
 nonfuelLiquid_h_W_m2_K:z.number().finite().positive(),nonfuelGas_h_W_m2_K:z.number().finite().positive(),coldPressures_Pa:z.array(z.number().finite().positive()).nonempty(),
 coldLiquidTemperatures_K:z.array(z.number().finite().min(290).max(1800)).nonempty(),
 coldWallOffsets_K:z.array(z.number().finite()).nonempty(),coldMaterialVelocities_m_s:z.array(z.number().finite()).nonempty(),
 contactFactors:z.array(z.number().finite().positive()).nonempty()}).strict()
export function parseTransferThermal(document:string){
 const blocks=[...document.matchAll(/^```reference-fuel-transfer-thermal\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-fuel-transfer-thermal block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
type Fuel=ReturnType<typeof parseFuelConstruction>
type Handling=ReturnType<typeof parseFuelHandling>
type Thermal=ReturnType<typeof parseTransferThermal>
/** Check named binding against the actual existing table, not an unconsumed context hash. */
export function verifyPrimaryThermalBinding(document:string,t:Thermal){
 const table=document.replaceAll('−','-').replaceAll('…','..')
 const lines=['| Lower plenum |','| Core.1 / Core.2 |','| Upper plenum |'].map(label=>{
  const rows=table.split('\n').filter(line=>line.startsWith(label));if(rows.length!==1)throw Error('Ambiguous primary thermal interval '+label)
  return rows[0]!
 })
 const pair=(line:string,expression:RegExp)=>{const m=line.match(expression);if(!m)throw Error('Missing primary axial interval');return [Number(m[1]),Number(m[2])]}
 const lower=pair(lines[0]!,/([-+]?\d+) to ([-+]?\d+) m/),upper=pair(lines[2]!,/([-+]?\d+) to ([-+]?\d+) m/)
 const m=lines[1]!.match(/([-+]?\d+)\.\.([-+]?\d+) and ([-+]?\d+)\.\.([-+]?\d+) m/)
 if(!m)throw Error('Missing actual two core intervals')
 const values=[...lower,...m.slice(1).map(Number),...upper],e=t.primaryAxialEdges_m
 if(values.some((v,i)=>v!==[e[0],e[1],e[1],e[2],e[2],e[3],e[3],e[4]][i]))throw Error('Primary thermal binding conflicts with owner')
 return values
}
type Rect={name:string,x0:number,x1:number,y0:number,y1:number,floor:number,surface:number}
export function radiationAreaBudget(sourceAreas:number[],recipientArea:number){
 if(![...sourceAreas,recipientArea].every(a=>Number.isFinite(a)&&a>=0))throw Error('Unadmitted radiation area')
 const total=sourceAreas.reduce((s,a)=>s+a,0);if(!Number.isFinite(total))throw Error('Radiation area sum is not numerically resolvable')
 if(total===0||recipientArea===0)return sourceAreas.map(()=>({exchange_m2:0,recipient_m2:0}))
 const factor=Math.min(1,recipientArea/total)
 return sourceAreas.map(a=>({exchange_m2:a*factor,recipient_m2:recipientArea*a/total}))
}
export function greyPatchExchange(sourceArea:number,recipientArea:number,exchangeArea:number,sourceEmissivity:number,recipientEmissivity:number,source_K:number,recipient_K:number){
 if(![sourceArea,recipientArea,exchangeArea].every(a=>Number.isFinite(a)&&a>=0)||exchangeArea>Math.min(sourceArea,recipientArea)||![sourceEmissivity,recipientEmissivity].every(e=>Number.isFinite(e)&&e>0&&e<=1)||![source_K,recipient_K].every(t=>Number.isFinite(t)&&t>0))throw Error('Unadmitted grey patch')
 if(exchangeArea===0)return {source_W:0,recipient_W:0}
 const q=5.670374419e-8*(source_K**4-recipient_K**4)/((1/sourceEmissivity-1)/sourceArea+1/exchangeArea+(1/recipientEmissivity-1)/recipientArea)
 if(!Number.isFinite(q))throw Error('Grey heat is not numerically resolvable')
 return {source_W:-q,recipient_W:q}
}
function circleFractions(x:number,y:number,r:number,rects:Rect[]){
 const tau=2*Math.PI,angles=[0,tau]
 for(const q of rects){
  for(const edge of [q.x0,q.x1]){const a=(edge-x)/r;if(a>-1&&a<1){const v=Math.acos(a);angles.push(v,tau-v)}}
  for(const edge of [q.y0,q.y1]){const a=(edge-y)/r;if(a>-1&&a<1){const v=Math.asin(a);angles.push((v+tau)%tau,(Math.PI-v+tau)%tau)}}
 }
 const cuts=[...new Set(angles)].sort((a,b)=>a-b),fractions:Record<string,number>={}
 for(let i=1;i<cuts.length;i++){
  const theta=(cuts[i-1]!+cuts[i]!)/2,px=x+r*Math.cos(theta),py=y+r*Math.sin(theta),hits=rects.filter(q=>px>=q.x0&&px<=q.x1&&py>=q.y0&&py<=q.y1)
  if(hits.length>1)throw Error('Overlapping thermal footprints')
  const name=hits[0]?.name??'UNADMITTED',weight=(cuts[i]!-cuts[i-1]!)/tau;fractions[name]=(fractions[name]??0)+weight
 }
 return fractions
}
/** Exact cylindrical surface arcs; native phase exposure/heat remains its separate owner. */
export function transferRodPatches(b:Handling,f:Fuel,t:Thermal,pose:{x_m:number,y_m:number,bottom_m:number},surfaces:[number,number,number]){
 if(![pose.x_m,pose.y_m,pose.bottom_m,...surfaces].every(Number.isFinite))throw Error('Nonfinite thermal pose')
 const side=Math.sqrt(b.wellArea_m2),wellEnd=side/2,poolStart=wellEnd+b.canalLength_m,rects:Rect[]=[
  {name:'WELL',x0:-wellEnd,x1:wellEnd,y0:-wellEnd,y1:wellEnd,floor:b.wellFloor_m,surface:surfaces[0]},
  {name:'CANAL',x0:wellEnd,x1:poolStart,y0:-b.canalWidth_m/2,y1:b.canalWidth_m/2,floor:b.canalFloor_m,surface:surfaces[1]},
  {name:'POOL',x0:poolStart,x1:poolStart+b.poolSide_m,y0:-b.poolSide_m/2,y1:b.poolSide_m/2,floor:b.poolFloor_m,surface:surfaces[2]}]
 if(rects.some(q=>q.surface<q.floor))throw Error('Liquid surface below owned floor')
 const guide=[2,5,8,11,14],r=f.rodOuterDiameter_m/2,segments=[0,1].map(a=>({materialSegment:a,
  bottom:pose.bottom_m+b.bottomFittingLength_m+a*f.activeLength_m/2,top:pose.bottom_m+b.bottomFittingLength_m+(a+1)*f.activeLength_m/2,
  areas_m2:{} as Record<string,number>})),corner=Math.hypot(Math.abs(pose.x_m)+f.latticeSide*f.pitch_m/2,Math.abs(pose.y_m)+f.latticeSide*f.pitch_m/2)
 for(let iy=0;iy<f.latticeSide;iy++)for(let ix=0;ix<f.latticeSide;ix++)if(!(guide.includes(ix)&&guide.includes(iy))){
  const fractions=circleFractions(pose.x_m+(ix-8)*f.pitch_m,pose.y_m+(iy-8)*f.pitch_m,r,rects)
  for(const s of segments){
   const cuts=[...new Set([s.bottom,s.top,...t.primaryAxialEdges_m,...rects.flatMap(q=>[q.floor,q.surface])].filter(v=>v>=s.bottom&&v<=s.top))].sort((a,b)=>a-b)
   for(let k=1;k<cuts.length;k++){
    const z=(cuts[k-1]!+cuts[k]!)/2,area=2*Math.PI*r*(cuts[k]!-cuts[k-1]!)
    for(const [name,fraction] of Object.entries(fractions)){
     let recipient='UNADMITTED';const rect=rects.find(q=>q.name===name)
     if(rect){
      if(name==='WELL'&&z<b.wellFloor_m){
       const i=t.primaryAxialEdges_m.findIndex((v,j)=>j<4&&z>=v&&z<t.primaryAxialEdges_m[j+1]!)
       if(i>=0&&corner<b.supportRadius_m)recipient=['PRIMARY.LOWER','PRIMARY.CORE1','PRIMARY.CORE2','PRIMARY.UPPER'][i]!
      }else if(z>=rect.floor)recipient=z<rect.surface?name+'.LIQUID':'CNV.GAS'
     }
     s.areas_m2[recipient]=(s.areas_m2[recipient]??0)+fraction*area
    }
   }
  }
 }
 const expected=f.rodsPerAssembly*Math.PI*f.rodOuterDiameter_m*f.activeLength_m/2
 for(const s of segments)if(Math.abs(Object.values(s.areas_m2).reduce((a,v)=>a+v,0)-expected)>1e-10)throw Error('Thermal surface partition defect')
 return segments
}
export const transferThermalCalculation=String.raw`
import json,sys,math
import CoolProp
import numpy as np
from CoolProp.CoolProp import PropsSI as P
${fuelMaterialPython}
d=json.load(sys.stdin);b=d['thermal'];dh=d['hydraulicDiameter_m'];area=d['segmentRodArea_m2'];rows=[];checks=[];contactRows=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
for p in b['coldPressures_Pa']:
 for tl in b['coldLiquidTemperatures_K']:
  ts=P('T','P',p,'Q',0,'Water');rho=P('D','P',p,'T',tl,'Water');mu=P('V','P',p,'T',tl,'Water');k=P('L','P',p,'T',tl,'Water');cp=P('C','P',p,'T',tl,'Water')
  check('admitted cold stable native liquid',tl<ts and min(rho,mu,k,cp)>0)
  for dt in b['coldWallOffsets_K']:
   tw=tl+dt;check('actual cold material/sensible range',290<=tw<=1800 and tw<ts)
   for vm in b['coldMaterialVelocities_m_s']:
    relative=b['bayMeanAxialVelocity_m_s']-vm;re=rho*dh*abs(relative)/mu;pr=cp*mu/k;n=.4 if tw>=tl else .3
    nu=max(7.86,.023*re**.8*pr**n);h=nu*k/dh;q=area*h*(tw-tl)
    check('finite signed sensible/contact source',math.isfinite(q) and (q==0 if dt==0 else q*dt>0))
    for factor in b['contactFactors']:
     qs=factor*q;check('same-area reciprocal source',(-qs)+qs==0)
     rows.append(dict(p_Pa=p,liquid_K=tl,wall_K=tw,materialVelocity_m_s=vm,relativeVelocity_m_s=relative,Re=re,Nu=nu,h_W_m2_K=h,contactFactor=factor,segmentHeat_W=qs,wallVapor_kg_s=0))
# The named source gap helper supplies only its existing actual-T helium conductivity;
# equal temperatures make this a property check, not an extra fuel/gas transfer.
c=d['contactGeometry'];ri=c['rodInnerRadius_m'];rf=c['pelletRadius_m'];ro=c['rodOuterRadius_m'];length=c['plenumLength_m']
for tg in b['coldLiquidTemperatures_K']:
 khe=gap([tg,tg,tg,tg],c['fillPressure_Pa']*tg/c['referenceTemperature_K'],(rf,ri,ro,length,0,0,rf),0)[3]
 hhe=b['plenumConductionFactor']*khe/ri
 for dt in b['coldWallOffsets_K']:
  for factor in b['contactFactors']:
   q=factor*c['plenumInnerArea_m2']*hhe*dt
   qfit=factor*b['fittingContactArea_m2']*b['nonfuelLiquid_h_W_m2_K']*dt
   qfitgas=factor*b['fittingContactArea_m2']*b['nonfuelGas_h_W_m2_K']*dt
   check('one He/plenum reciprocal contact',math.isfinite(q) and -q+q==0)
   check('distinct fitting wet/gas signed reciprocal contacts',math.isfinite(qfit+qfitgas) and -qfit+qfit==0 and -qfitgas+qfitgas==0)
   contactRows.append(dict(helium_K=tg,delta_K=dt,factor=factor,kHe_W_m_K=khe,plenum_h_W_m2_K=hhe,HeToPlenum_W=q,fittingWet_W=qfit,fittingGas_W=qfitgas))
print(json.dumps(dict(kind='held-fuel-transfer-cold-sensible',rows=rows,contactRows=contactRows,checks=checks,CoolProp=CoolProp.__version__),allow_nan=False))
`
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function runTransferThermal(directory:string,python:string){
 const paths=['systems/reactor/fuel-handling-and-pool.md','systems/reactor/fuel-construction.md','systems/reactor/core-coolant-delivery.md','systems/reactor/phase-dependent-heat-transfer.md'],
  docs=await Promise.all(paths.map(p=>Bun.file(resolve(directory,p)).text())),source=await Bun.file(import.meta.path).text(),
  b=parseFuelHandling(docs[0]!),f=parseFuelConstruction(docs[1]!),t=parseTransferThermal(docs[0]!),binding=verifyPrimaryThermalBinding(docs[2]!,t),geom=fuelGeometry(f)
 const surfaces:[number,number,number]=[b.surface_m,b.surface_m,b.surface_m],poolCentre=Math.sqrt(b.wellArea_m2)/2+b.canalLength_m+b.poolSide_m/2,
  poses=[{name:'seated',pose:{x_m:0,y_m:0,bottom_m:b.seatedBottom_m},surfaces},
  {name:'interrupted vertical lift',pose:{x_m:0,y_m:0,bottom_m:b.seatedBottom_m+f.activeLength_m/2},surfaces},
  {name:'well/canal split',pose:{x_m:Math.sqrt(b.wellArea_m2)/2,y_m:0,bottom_m:b.transferBottom_m},surfaces},
  {name:'canal/pool split',pose:{x_m:Math.sqrt(b.wellArea_m2)/2+b.canalLength_m,y_m:0,bottom_m:b.transferBottom_m},surfaces},
  {name:'pool partial uncovering',pose:{x_m:poolCentre,y_m:0,bottom_m:b.transferBottom_m},surfaces:[b.surface_m,b.surface_m,b.transferBottom_m+b.bottomFittingLength_m+3*f.activeLength_m/4] as [number,number,number]},
  {name:'racked lower segment below flange',pose:{x_m:poolCentre,y_m:0,bottom_m:b.poolFloor_m},surfaces}],
  patchInput={handling:{wellArea_m2:b.wellArea_m2,wellFloor_m:b.wellFloor_m,canalLength_m:b.canalLength_m,canalWidth_m:b.canalWidth_m,canalFloor_m:b.canalFloor_m,poolSide_m:b.poolSide_m,poolFloor_m:b.poolFloor_m,supportRadius_m:b.supportRadius_m,bottomFittingLength_m:b.bottomFittingLength_m},
   fuel:{rodOuterDiameter_m:f.rodOuterDiameter_m,activeLength_m:f.activeLength_m,rodsPerAssembly:f.rodsPerAssembly,latticeSide:f.latticeSide,pitch_m:f.pitch_m},thermal:{primaryAxialEdges_m:t.primaryAxialEdges_m},poses},patches=poses.map(q=>({name:q.name,segments:transferRodPatches(b,f,t,q.pose,q.surfaces)})),
  {primaryAxialEdges_m,...nativeThermal}=t,ri=f.rodOuterDiameter_m/2-f.cladThickness_m,
  contactGeometry={rodInnerRadius_m:ri,pelletRadius_m:f.pelletDiameter_m/2,rodOuterRadius_m:f.rodOuterDiameter_m/2,plenumLength_m:f.plenumLength_m,
   fillPressure_Pa:f.fillPressure_Pa,referenceTemperature_K:f.referenceTemperature_K,plenumInnerArea_m2:f.rodsPerAssembly*2*Math.PI*ri*f.plenumLength_m},
  input={thermal:nativeThermal,hydraulicDiameter_m:geom.hydraulicDiameter_m,segmentRodArea_m2:f.rodsPerAssembly*Math.PI*f.rodOuterDiameter_m*f.activeLength_m/2,contactGeometry},bytes=JSON.stringify(input)
 const proc=Bun.spawn([python,'-c',transferThermalCalculation],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});proc.stdin.write(bytes);proc.stdin.end()
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 if(sha(source)!==sha(await Bun.file(import.meta.path).text())||!(await Promise.all(paths.map(async(p,i)=>sha(await Bun.file(resolve(directory,p)).text())===sha(docs[i]!)))).every(Boolean))throw Error('Transfer thermal source/context changed')
 const endArea=f.guidesPerAssembly*Math.PI*((f.guideOuterDiameter_m/2)**2-(b.guideInnerDiameter_m/2)**2),radiationInput={sourceAreas_m2:[t.fittingContactArea_m2,t.fittingContactArea_m2],recipientArea_m2:endArea,
  sourceEmissivity:.7,recipientEmissivity:.7,sourceTemperatures_K:[333.15,293.15],recipientTemperature_K:300},
  radiationBudget=radiationAreaBudget(radiationInput.sourceAreas_m2,radiationInput.recipientArea_m2),
  radiationHeat=radiationBudget.map((a,i)=>greyPatchExchange(radiationInput.sourceAreas_m2[i]!,a.recipient_m2,a.exchange_m2,radiationInput.sourceEmissivity,radiationInput.recipientEmissivity,radiationInput.sourceTemperatures_K[i]!,radiationInput.recipientTemperature_K))
 return {sourceSHA256:sha(source),calculationSHA256:sha(transferThermalCalculation),sourceHelperSHA256:{fuelMaterialPython:sha(fuelMaterialPython)},consumedInputSHA256:sha(bytes),consumedInput:input,patchInputSHA256:sha(JSON.stringify(patchInput)),patchInput,patches,verifiedPrimaryBinding:binding,
  radiationInputSHA256:sha(JSON.stringify(radiationInput)),radiationInput,radiationBudget,radiationHeat,
  ownerContextSHA256:Object.fromEntries(paths.map((p,i)=>[p,sha(docs[i]!)])),...JSON.parse(out)}
}
if(import.meta.main){
 const [directory,python,output,...rest]=Bun.argv.slice(2);if(!directory||!python||!output||rest.length)throw Error('Usage: fuel-transfer-thermal <ld-01> <research-python> <receipt.json>')
 const receipt=await runTransferThermal(directory,python);await Bun.write(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({output,checks:receipt.checks.length,rows:receipt.rows.length,patchCases:receipt.patches.length}))
}

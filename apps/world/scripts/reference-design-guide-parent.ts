/** Fresh seated-guide native inventory join only; no reached-history migration. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { parseInitializationBasis } from './reference-design-initialization'
import { parseColdParent, coldHydrostaticInventoryPython, coldParentCalculation } from './reference-design-cold-parent'
import { parseColdPressure } from './reference-design-cold-pressure'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { fuelHandlingChecks, parseFuelHandling } from './reference-design-fuel-handling'
import { parseColdNuclear } from './reference-design-cold-nuclear'

const sourceSchema=z.object({fuelTemperature_K:z.literal(300),activeRetainedTracer_kgEq:z.literal(0),
 freshSourceVector:z.array(z.literal(0)).length(17),capsule:z.object({identity:z.literal('LD01.CORE.SOURCE.CF252'),age_year:z.number().finite().nonnegative()}).strict()}).strict()
export function freshGuideSource(input:unknown){return sourceSchema.parse(input)}

export const guideParentCalculation=String.raw`
import json,sys,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
d=json.load(sys.stdin);g=9.80665;checks=[];geom=d['geometry'];p0=d['anchor']['pressure_Pa'];T0=d['anchor']['temperature_K'];z0=d['anchor']['elevation_m'];ratio=d['ratio']
def require(name,condition,**v):
 if not condition:raise ValueError(name+': '+str(v))
 checks.append(dict(name=name,**v))
${coldHydrostaticInventoryPython}
active=geom['active'];lower=geom['lower'];upper=geom['upper'];A=(geom['guideInnerArea_m2']-geom['sourceArea_m2'])
for name,q in [('ACTIVE',active),('LOWER',lower),('UPPER',upper)]:
 lo,hi=(q['bottom_m'],q['top_m']) if name=='ACTIVE' else (q['boreBottom_m'],q['boreTop_m'])
 require(name+' bore actual axial area identity',abs(q['boreVolume_m3']-A*(hi-lo))<1e-12)
region('ACTIVE.EXTERNAL',active['externalFreeVolume_m3'],lambda f:-2+4*f,mainField,ratio)
region('ACTIVE.GUIDE',active['boreVolume_m3'],lambda f:-2+4*f,mainField,ratio)
# Existing LOWER retains its actual mixed native EOS, -3 m effective centroid
# reduction and mean-density head; this is not a resolved changed fluid profile.
pl,tl=mainField(-2);pc=brentq(lambda p:p-water(p,tl)[0]*g-pl,pl,pl+2e4);rl,ul=water(pc,tl)
lowerExternal=dict(owner='LOWER.EXTERNAL',volume_m3=lower['externalFreeVolume_m3'],water_kg=lower['externalFreeVolume_m3']*rl,U_J=lower['externalFreeVolume_m3']*rl*ul,PE_J=lower['externalFreeVolume_m3']*rl*g*(-3),tracer_kg_eq=lower['externalFreeVolume_m3']*rl*ratio,pressureDatum_m=-3,meanPressure_Pa=pc,temperature_K=tl,geometryMeaning='Retained owned mixed LOWER effective centroid/head, not new exact remaining-water centroid')
require('mixed LOWER actual core-entry pressure retained',abs(pc-rl*g-pl)<1e-5)
region('LOWER.GUIDE',lower['boreVolume_m3'],lambda f:lower['boreBottom_m']+(lower['boreTop_m']-lower['boreBottom_m'])*f,mainField,ratio)
# Upper envelope is still native hydrostatic; subtract each solid at its actual
# axial interval instead of spreading the displacement uniformly over +2..+4.
ua=d['oldUpperVolume_m3']/2;up=d['plenumLength_m'];ut=upper['boreTop_m'];go=geom['guideOuterArea_m2'];st=geom['sourceArea_m2'];sa=d['sourceThimbleTop_m']
upperSegments=[(2,2+up,ua-go-upper['sealedRodPlenumDisplacement_m3']/up),
 (2+up,ut,ua-go-upper['fittingDisplacement_m3']/(ut-(2+up))),
 (ut,sa,ua-st),(sa,4,ua)]
upperExternal=[]
for i,(lo,hi,area) in enumerate(upperSegments):
 require('actual upper interval '+str(i),hi>lo and area>0)
 upperExternal.append(region('UPPER.EXTERNAL.'+str(i),area*(hi-lo),lambda f,lo=lo,hi=hi:lo+(hi-lo)*f,mainField,ratio))
require('upper external free volume from actual solid intervals',abs(sum(r['volume_m3'] for r in upperExternal)-upper['externalFreeVolume_m3'])<1e-12)
region('UPPER.GUIDE',upper['boreVolume_m3'],lambda f:2+(ut-2)*f,mainField,ratio)
# Reference external LOWER geometry is mixed, so the new bore is not secretly
# forced into exact rest at both ends. Report that real preparation mismatch.
z=lower['boreBottom_m'];pb,tb=mainField(z);mixedPortPressure=pc-rl*g*(z+3)
endpoint=dict(elevation_m=z,borePressure_Pa=pb,lowerPortPressure_Pa=mixedPortPressure,pressureDifference_Pa=pb-mixedPortPressure,boreTemperature_K=tb,lowerTemperature_K=tl)
require('finite reported guide/LOWER preparation mismatch',all(math.isfinite(v) for v in endpoint.values()))
def add(records):return {key:sum(q[key] for q in records) for key in ['volume_m3','water_kg','U_J','PE_J','tracer_kg_eq']}
external=rows[0];bore=rows[1];newCore=add([external,bore]);guides=add([r for r in rows if '.GUIDE' in r['owner']])
require('active water geometry equals external plus guide once',abs(newCore['volume_m3']-active['totalFreeVolume_m3'])<1e-12)
require('fresh native tracer follows actual native mass',abs(newCore['tracer_kg_eq']-newCore['water_kg']*ratio)<1e-12)
require('old external water integral retained',abs(external['water_kg']-d['oldActiveWater_kg'])<1e-5,waterDifference_kg=external['water_kg']-d['oldActiveWater_kg'])
require('end bores partition existing plenum space',lower['totalFreeVolume_m3']<d['oldLowerVolume_m3'] and upper['totalFreeVolume_m3']<d['oldUpperVolume_m3'])
require('no duplicate end-bore core feedback',newCore['volume_m3']<active['externalFreeVolume_m3']+guides['volume_m3'])
sourceInput={**d['source'], 'activeExternalWater_kg':external['water_kg'],'activeGuideWater_kg':bore['water_kg'], 'activeExternalMobileTracer_kgEq':external['tracer_kg_eq'],'activeGuideMobileTracer_kgEq':bore['tracer_kg_eq']}
print(json.dumps(dict(scope='Original fresh seated geometry/native inventory only; no filling, reached guide history, neutron/source qualification, complete new thermal ledger or handling authority',packages=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,sourceInput=sourceInput,active=newCore,lowerExternal=lowerExternal,upperExternal=add(upperExternal),guideRows=[r for r in rows if '.GUIDE' in r['owner']],nativeRows=rows,lowerBoreEndpoint=endpoint)))
`

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function runGuideParent(directory:string,priorReceipt:string,python:string){
 const paths={parent:'model/connected-primary-initialization.md',pressure:'safety/cold-pressure-and-startup-protection.md',fuel:'systems/reactor/fuel-construction.md',handling:'systems/reactor/fuel-handling-and-pool.md',nuclear:'systems/reactor/cold-source-and-startup.md'}
 const docs=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await Bun.file(resolve(directory,p)).text()]))) as Record<keyof typeof paths,string>
 if(!docs.parent.includes('Fresh `n`, six precursors, six delayed-energy stores, iodine/xenon/promethium/samarium are zero'))throw Error('Reconcile actual fresh 17-state source preparation')
 const priorText=await Bun.file(priorReceipt).text(),prior=z.object({calculationSHA256:z.string().regex(/^[0-9a-f]{64}$/),core:z.object({water_kg:z.number().finite().positive()})}).parse(JSON.parse(priorText))
 if(prior.calculationSHA256!==sha(coldParentCalculation))throw Error('Prior cold-parent payload is not the unchanged native parent')
 const selectedGeometry=fuelHandlingChecks(parseFuelHandling(docs.handling),parseFuelConstruction(docs.fuel)).freshGeometry
 // Only actual native/identity inputs below enter the consumed-input hash.
 // Other derived material/displacement fields remain in their geometry owner.
 const pick=(x:Record<string,number>,keys:string[])=>Object.fromEntries(keys.map(k=>[k,x[k]]))
 const geometry={guideOuterArea_m2:selectedGeometry.guideOuterArea_m2,guideInnerArea_m2:selectedGeometry.guideInnerArea_m2,sourceArea_m2:selectedGeometry.sourceArea_m2,
  active:pick(selectedGeometry.active,['bottom_m','top_m','boreVolume_m3','externalFreeVolume_m3','totalFreeVolume_m3']),
  lower:pick(selectedGeometry.lower,['boreBottom_m','boreTop_m','boreVolume_m3','externalFreeVolume_m3','totalFreeVolume_m3']),
  upper:pick(selectedGeometry.upper,['boreBottom_m','boreTop_m','boreVolume_m3','externalFreeVolume_m3','totalFreeVolume_m3','sealedRodPlenumDisplacement_m3','fittingDisplacement_m3'])}
 const handling=parseFuelHandling(docs.handling),base=parseInitializationBasis(docs.parent),selection=parseColdParent(docs.parent),pressure=parseColdPressure(docs.pressure),nuclear=parseColdNuclear(docs.nuclear)
 const source=freshGuideSource({fuelTemperature_K:nuclear.coldPreparation.temperature_K,activeRetainedTracer_kgEq:0,freshSourceVector:Array.from({length:17},()=>0),capsule:{identity:nuclear.source.identity,age_year:nuclear.source.ageAtPreparation_year}})
 const consumed={geometry,anchor:{pressure_Pa:pressure.coldPzr.hotPressure_Pa,temperature_K:pressure.coldPzr.temperature_K,elevation_m:2.5},ratio:selection.primaryAbsorberRatio,oldLowerVolume_m3:base.volumes_m3[1],oldUpperVolume_m3:base.volumes_m3[4],oldActiveWater_kg:prior.core.water_kg,plenumLength_m:parseFuelConstruction(docs.fuel).plenumLength_m,sourceThimbleTop_m:handling.sourceThimbleTop_m,source}
 const serialized=JSON.stringify(consumed),sourceHash=sha(await Bun.file(import.meta.path).text()),geometryHash=sha(await Bun.file(resolve(import.meta.dir,'reference-design-fuel-handling.ts')).text())
 const proc=Bun.spawn([python,'-c',guideParentCalculation],{stdin:new Blob([serialized]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 if(sourceHash!==sha(await Bun.file(import.meta.path).text())||geometryHash!==sha(await Bun.file(resolve(import.meta.dir,'reference-design-fuel-handling.ts')).text()))throw Error('Guide/native source changed during calculation')
 return {sourceSHA256:sourceHash,calculationSHA256:sha(guideParentCalculation),consumedInputSHA256:sha(serialized),consumedInput:consumed,geometrySourceSHA256:geometryHash,unchangedColdParentCalculationSHA256:sha(coldParentCalculation),priorParentReceiptSHA256:sha(priorText),ownerContextSHA256:Object.fromEntries(Object.entries(docs).map(([k,v])=>[paths[k as keyof typeof paths],sha(v)])),...JSON.parse(out)}
}
if(import.meta.main){const [directory,prior,python,receipt,...rest]=Bun.argv.slice(2);if(!directory||!prior||!python||!receipt||rest.length)throw Error('Usage: guide-parent <ld-01> <prior-cold-parent.json> <research-python> <receipt.json>');const result=await runGuideParent(directory,prior,python);await Bun.write(receipt,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({receipt,checks:result.checks.length,sourceInput:result.sourceInput,lowerBoreEndpoint:result.lowerBoreEndpoint},null,2))}

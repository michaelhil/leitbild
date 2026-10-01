/** Local gas-path/capacity screens, not a condenser drawdown or rolling simulation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { vacuumSelection } from './reference-design-cold-vacuum'
import { pureWaterNozzleFunctions } from './reference-design-pure-water-nozzle'
const pos=z.number().finite().positive()
const schema=z.object({volume_m3:pos,area_m2:pos,floor_m:z.number().finite(),
  outerCdA_m2:pos,innerCdA_m2:pos,supplyCdA_m2:pos,drainCdA_m2:pos,
  targetPressure_Pa:pos,metalCapacity_J_K:pos,fluidContact_W_K:pos,roomContact_W_K:pos}).strict()
export function parseGland(document:string) {
  const blocks=[...document.matchAll(/^```reference-gland\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-gland block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
/** Exact perfect-air isentropic nozzle limit; actual wet-mixture paths retain their native owner. */
export function dryAirFlux(pressure:number,temperature:number,downstream:number) {
  if (![pressure,temperature,downstream].every(Number.isFinite)||pressure<=0||temperature<=0||downstream<=0||downstream>pressure)
    throw Error('Invalid forward gas-nozzle boundaries')
  const R=287,cp=1005,gamma=cp/(cp-R),critical=(2/(gamma+1))**(gamma/(gamma-1))
  const ratio=Math.max(downstream/pressure,critical)
  return pressure/Math.sqrt(R*temperature)*Math.sqrt(2*gamma/(gamma-1)*(ratio**(2/gamma)-ratio**((gamma+1)/gamma)))
}
export const glandCalculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
d=json.load(sys.stdin);b=d['basis'];Q=d['vacuum']['displacement_m3_s'];checks=[];patm=101325.;Tair=313.15;Tcond=313.15;pwater=P('P','T',Tcond,'Q',1,'Water')
exec(d['nozzleFunctions'])
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
def airflux(p,T,pd):
 R=287.;gamma=1005./718.;ratio=max(pd/p,(2/(gamma+1))**(gamma/(gamma-1)))
 return p/math.sqrt(R*T)*math.sqrt(2*gamma/(gamma-1)*(ratio**(2/gamma)-ratio**((gamma+1)/gamma)))
# Unsealed bootstrap: actual two serial restrictions, held 40C air at all boundaries.
# Holding temperature supplies/receives heat in this apparatus; it is not a native trajectory.
bootstrap=[]
for scale in [.5,1.,2.]:
 outer=scale*b['outerCdA_m2'];inner=scale*b['innerCdA_m2']
 def flows(pg,pc):return outer*airflux(patm,Tair,pg),inner*airflux(pg,Tair,pc)
 def pg(pc):return brentq(lambda p:flows(p,pc)[0]-flows(p,pc)[1],pc,patm)
 def balance(pc):
  pressure=pg(pc);load=flows(pressure,pc)[1]
  return load-Q*(pc-pwater)/(287*Tcond)
 pc=brentq(balance,pwater+1,patm-1,xtol=1e-6);pressure=pg(pc);load=flows(pressure,pc)[1]
 require('unsealed series air/extractor capacity equilibrium',pc<12000 and abs(balance(pc))<1e-7,scale=scale,condenserPressure_Pa=pc,glandPressure_Pa=pressure,airLoad_kg_s=load)
 bootstrap.append(dict(scale=scale,condenserPressure_Pa=pc,glandPressure_Pa=pressure,airLoad_kg_s=load))
require('isothermal equilibrium is not instantaneous recovered vacuum',bootstrap[1]['condenserPressure_Pa']>pwater)
# An independently named condenser fault bypasses both healthy gland restrictions.
faultArea=.003
faultPressure=brentq(lambda pc:faultArea*airflux(patm,Tair,pc)-Q*(pc-pwater)/(287*Tcond),pwater+1,patm-1)
require('condenser fault still defeats receiver admission',faultPressure>12000,equilibriumPressure_Pa=faultPressure,area_m2=faultArea)
# Dry pure-steam snapshot at actual regulator target, not a supplied plant gland state.
pg=b['targetPressure_Pa'];Tg=385.;pc=12000.
inside=b['innerCdA_m2']*waterflux(pg,Tg,pc);outside=b['outerCdA_m2']*waterflux(pg,Tg,patm)
required=inside+outside;gasDrain=b['drainCdA_m2']*waterflux(pg,Tg,pc);supply=[]
metalCold_W=b['fluidContact_W_K']*(Tg-313.15)
hgl=P('Hmass','P',pg,'T',Tg,'Water');hl=P('Hmass','P',pg,'Q',0,'Water')
# Frozen steam/condensate enthalpy screen only; neither pressure nor metal is held in the plant.
coldCondensation=metalCold_W/(hgl-hl)
for p in [.3e6,.5e6,1e6,6e6]:
 Ts=P('T','P',p,'Q',1,'Water')+1 # Explicit one-K superheated source apparatus, not HEADER truth.
 capacity=b['supplyCdA_m2']*waterflux(p,Ts,pg)
 require('native CLOSED-drain/no-metal-load source capacity',capacity>required,pressure_Pa=p,sourceTemperature_K=Ts,capacity_kg_s=capacity,required_kg_s=required)
 openRequired=required+gasDrain;coldRequired=openRequired+coldCondensation
 supply.append(dict(sourcePressure_Pa=p,sourceTemperature_K=Ts,capacity_kg_s=capacity,requiredOpening=required/capacity,gasDrainRequired_kg_s=openRequired,coldMetalGasDrainRequired_kg_s=coldRequired,gasDrainFits=bool(capacity>openRequired),coldMetalGasDrainFits=bool(capacity>coldRequired)))
require('0.3MPa marginal CLOSED capacity is not OPEN-drain duty',not supply[0]['gasDrainFits'],capacity_kg_s=supply[0]['capacity_kg_s'],required_kg_s=supply[0]['gasDrainRequired_kg_s'])
require('0.3MPa does not establish cold metal preparation',not supply[0]['coldMetalGasDrainFits'],heat_W=metalCold_W)
require('0.5MPa admits frozen cold-metal/open-drain comparison',supply[1]['coldMetalGasDrainFits'],capacity_kg_s=supply[1]['capacity_kg_s'],required_kg_s=supply[1]['coldMetalGasDrainRequired_kg_s'])
require('normal gland inward and outward export are real steam losses',inside>0 and outside>0,inward_kg_s=inside,outward_kg_s=outside)
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),checks=checks,bootstrap=bootstrap,condenserFault=dict(area_m2=faultArea,equilibriumPressure_Pa=faultPressure),steamSnapshot=dict(temperature_K=Tg,pressure_Pa=pg,inside_kg_s=inside,outside_kg_s=outside,gasDrain_kg_s=gasDrain,coldMetal_W=metalCold_W,coldCondensation_kg_s=coldCondensation,supply=supply))))
`
if(import.meta.main){
  const [owner,python,receipt,...rest]=Bun.argv.slice(2)
  if(!owner||!python||!receipt||rest.length)throw Error('Usage: gland <owner.md> <research-python> <receipt.json>')
  const text=await Bun.file(owner).text(),basis=parseGland(text),input=JSON.stringify({basis,vacuum:vacuumSelection,nozzleFunctions:pureWaterNozzleFunctions})
  const proc=Bun.spawn([python,'-c',glandCalculation],{stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const result={scope:'Held-temperature gas restriction/extractor capacity and pure-steam source snapshots; no reached vacuum, native plenum or rolling transient',sourceSHA256:hash(await Bun.file(import.meta.path).text()),vacuumHelperSHA256:hash(await Bun.file(new URL('./reference-design-cold-vacuum.ts',import.meta.url)).text()),nozzleFunctionsSHA256:hash(pureWaterNozzleFunctions),reviewedOwnerSHA256:hash(text),calculationSHA256:hash(glandCalculation),consumedInputSHA256:hash(input),basis,...JSON.parse(out)}
  await Bun.write(receipt,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({receipt,checks:result.checks.length,bootstrap:result.bootstrap,steam:result.steamSnapshot,condenserFault:result.condenserFault}))
}

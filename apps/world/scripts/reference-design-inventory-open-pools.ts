/** Bounded open inventory-pool receipt/phase/overflow checks; no plant runtime or hydraulic trajectory. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {z} from 'zod'
import {absorberPartition,transferLiquid} from './reference-design-absorber-retention'

const positive=z.number().finite().positive(),finite=z.number().finite()
const schema=z.object({pressure_Pa:positive,gravity_m_s2:positive,tankArea_m2:positive,tankFloor_m:finite,
 tankHeight_m:positive,collectionArea_m2:positive,collectionFloor_m:finite,weirWidth_m:positive,
 weirCoefficient:positive,initialTemperature_C:positive,initialReceiverVolume_m3:positive,receiptPort_m:finite,
 parcelMass_kg:positive,nominalPressure_MPa:positive,nominalTemperature_C:positive,hotPressure_MPa:positive,
 hotTemperature_C:positive,boilEnergy_J:positive,dryMass_kg:positive,tracer_kg_eq:positive}).strict()
 .refine(b=>b.initialReceiverVolume_m3<b.tankArea_m2*b.tankHeight_m&&b.collectionFloor_m<b.tankFloor_m+b.tankHeight_m,
 'Invalid initial volume or collection geometry')
export function parseOpenPools(document:string){
 const blocks=[...document.matchAll(/^```reference-inventory-open-pools\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw new Error('Expected one open-pools record')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function signedSpill(tankSurface:number,collectionSurface:number,tankDensity:number,collectionDensity:number,
 b:ReturnType<typeof parseOpenPools>){
 if(![tankSurface,collectionSurface,tankDensity,collectionDensity].every(Number.isFinite)||tankDensity<=0||collectionDensity<=0)
  throw new Error('Invalid spill state')
 const direction=Math.sign(tankSurface-collectionSurface)
 if(direction===0)return 0
 const donor=Math.max(tankSurface,collectionSurface),receiver=Math.min(tankSurface,collectionSurface)
 const head=donor-Math.max(b.tankFloor_m+b.tankHeight_m,receiver)
 if(head<=0)return 0
 return direction*(direction>0?tankDensity:collectionDensity)*b.weirCoefficient*b.weirWidth_m*head**1.5
}
export const openPoolCalculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI
from scipy.optimize import brentq
b=json.load(sys.stdin);checks=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
p=b['pressure_Pa'];g=b['gravity_m_s2'];A=b['tankArea_m2'];z=b['tankFloor_m'];port=b['receiptPort_m']
Ts=PropsSI('T','P',p,'Q',0,'Water');hf=PropsSI('H','P',p,'Q',0,'Water');hg=PropsSI('H','P',p,'Q',1,'Water')
rf=PropsSI('D','P',p,'Q',0,'Water');hfg=hg-hf
def liquid(T):
 if T==Ts:return dict(T=T,h=hf,rho=rf)
 return dict(T=T,h=PropsSI('H','P',p,'T',T,'Water'),rho=PropsSI('D','P',p,'T',T,'Water'))
def pool(M,T,area=A,floor=z):
 a=liquid(T);depth=M/(a['rho']*area);PE=g*M*(floor+depth/2);E=M*a['h']+PE
 return dict(mass_kg=M,temperature_C=T-273.15,depth_m=depth,volume_m3=depth*area,
  energy_J=E,internalEnergy_J=M*(a['h']-p/a['rho']),potentialEnergy_J=PE,density_kg_m3=a['rho'])
initialT=b['initialTemperature_C']+273.15;initial=pool(b['initialReceiverVolume_m3']*liquid(initialT)['rho'],initialT)
rows=[]
for name,sourceP,sourceT in [('nominal',b['nominalPressure_MPa']*1e6,b['nominalTemperature_C']+273.15),
 ('hot-receipt',b['hotPressure_MPa']*1e6,b['hotTemperature_C']+273.15),('pure-steam-donor',p,Ts+50)]:
 h=PropsSI('H','P',sourceP,'T',sourceT,'Water');m=b['parcelMass_kg']
 if h<hf:
  x=0.;hl=h;hv=0.
 elif h<=hg:
  x=(h-hf)/hfg;hl=hf;hv=hg
 else:x=1.;hl=0.;hv=h
 ml=m*(1-x);mv=m*x;received=ml*(hl+g*port);gas=mv*(hv+g*port);incoming=m*(h+g*port)
 check(name+' water split',abs(ml+mv-m)<1e-10)
 check(name+' phase total-enthalpy split',abs(received+gas-incoming)<1e-6)
 M=initial['mass_kg']+ml;target=initial['energy_J']+received
 if ml==0:final=initial.copy()
 else:
  T=brentq(lambda T:pool(M,T)['energy_J']-target,273.16,Ts,xtol=1e-10)
  final=pool(M,T)
 residual=final['energy_J']+gas-initial['energy_J']-incoming
 Tf=final['temperature_C']+273.15
 cp=PropsSI('C','P',p,'T',Tf,'Water');alpha=PropsSI('ISOBARIC_EXPANSION_COEFFICIENT','P',p,'T',Tf,'Water')
 # Native E=M*h+PE sensitivity at fixed mass and pressure; original2m3 fixture retains .001 J floor.
 derivative=final['mass_kg']*(cp+g*final['depth_m']*alpha/2)
 arithmetic=8*sys.float_info.epsilon*(abs(final['energy_J'])+abs(initial['energy_J'])+abs(incoming)+abs(gas))
 allowance=max(1e-3,abs(derivative)*1e-10+arithmetic)
 check(name+' recovered native pool energy',abs(residual)<allowance)
 workResidual=final['internalEnergy_J']+p*final['volume_m3']+final['potentialEnergy_J']-final['energy_J']
 workAllowance=max(1e-6,8*sys.float_info.epsilon*(abs(final['internalEnergy_J'])+abs(p*final['volume_m3'])+abs(final['potentialEnergy_J'])+abs(final['energy_J'])))
 check(name+' native open work identity',abs(workResidual)<workAllowance)
 rows.append(dict(name=name,incomingMass_kg=m,incomingEnthalpy_J_kg=h,liquidReceipt_kg=ml,
  steamExport_kg=mv,gasEnergyExport_J=gas,liquidEnergyReceipt_J=received,final=final,
  nativeEnergyResidual_J=residual,nativeEnergyResidual_J_kg=residual/final['mass_kg'],
  originalAbsoluteScreenPassed=abs(residual)<1e-3,propertyRecoveryAllowance_J=allowance,
  energyTemperatureDerivative_J_K=derivative,arithmeticAllowance_J=arithmetic,
  openWorkIdentityResidual_J=workResidual,openWorkIdentityAllowance_J=workAllowance))
check('nominal remains liquid',rows[0]['steamExport_kg']==0)
check('hot receipt flashes rather than heating pool with exported steam',0<rows[1]['steamExport_kg']<b['parcelMass_kg'])
check('pure steam donor bypass does not heat liquid pool',rows[2]['final']==initial)
# Finite energy increments on a saturated coupon, not an installed tank heater or response clock.
M0=b['dryMass_kg'];start=pool(M0,Ts);dm=b['boilEnergy_J']/hfg
check('partial evaporation challenge leaves water',0<dm<M0)
end=pool(M0-dm,Ts);vapE=dm*(hg+g*(z+(M0+M0-dm)/(2*rf*A)))
check('partial boil energy with changing surface elevation',abs(end['energy_J']+vapE-start['energy_J']-b['boilEnergy_J'])<1e-6)
dryQ=M0*hfg;dryGas=M0*(hg+g*(z+M0/(2*rf*A)))
check('exact dry energy and zero remaining water',abs(dryGas-start['energy_J']-dryQ)<1e-6)
coolTarget=start['energy_J']-b['boilEnergy_J'];coolT=brentq(lambda T:pool(M0,T)['energy_J']-coolTarget,273.16,Ts)
check('negative saturated excess cools without atmospheric condensation',coolT<Ts)
refillM=10.;refillH=liquid(initialT)['h']+g*port;refillT=brentq(lambda T:pool(refillM,T)['energy_J']-refillM*refillH,273.16,Ts)
refill=pool(refillM,refillT)
check('dry refill conserves incoming energy',abs(refill['energy_J']-refillM*refillH)<1e-4)
# Independently finite collection receipt, including loss of elevation into the receiving pool.
spillM=1.;spillSource=liquid(initialT);crest=z+b['tankHeight_m'];spillH=spillSource['h']+g*(crest+.1)
ct=brentq(lambda T:pool(spillM,T,b['collectionArea_m2'],b['collectionFloor_m'])['energy_J']-spillM*spillH,273.16,Ts)
collection=pool(spillM,ct,b['collectionArea_m2'],b['collectionFloor_m'])
check('finite collection native recovery includes descent energy',abs(collection['energy_J']-spillM*spillH)<1e-4)
check('no artificial constant-temperature collection sink',ct>initialT)
print(json.dumps(dict(scope='Fixed native receiving flash/pool recovery and finite energy increments; no hydraulic trajectory, interlock timing or protected charging fault',
 libraries={'CoolProp':CoolProp.__version__,'SciPy':scipy.__version__},basis=b,saturation_C=Ts-273.15,saturatedLiquidDensity_kg_m3=rf,
 latentHeat_J_kg=hfg,initial=initial,receipts=rows,partialBoil=dict(evaporated_kg=dm,final=end,exportEnergy_J=vapE),
 dry=dict(waterMass_kg=0,waterEnergy_J=0,temperature_C=None,requiredEnergy_J=dryQ,exportEnergy_J=dryGas),
 cooledTemperature_C=coolT-273.15,refill=refill,collection=collection,checks=checks)))
`

if(import.meta.main){
 const [owner,python,receipt,...extra]=Bun.argv.slice(2)
 if(!owner||!python||extra.length)throw new Error('Usage: <inventory-owner.md> <python-with-CoolProp> [receipt.json]')
 const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
 const paths=[owner,import.meta.path,resolve(import.meta.dir,'reference-design-absorber-retention.ts')]
 const sources=paths.map(path=>({path,sha256:hash(path)})),basis=parseOpenPools(readFileSync(owner,'utf8'))
 const run=spawnSync(python,['-c',openPoolCalculation],{input:JSON.stringify(basis),encoding:'utf8'})
 if(run.status!==0)throw new Error(run.stderr||'Open-pool calculation failed')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
 const result=JSON.parse(run.stdout),checks:string[]=result.checks
 const check=(name:string,ok:boolean)=>{if(!ok)throw new Error(name);checks.push(name)}
 // Only the two actual liquid-origin donors carry tracer; already gaseous native steam does not.
 const flashTracer=result.receipts.map((row:{name:string,final:{mass_kg:number},liquidReceipt_kg:number})=>{
  const incomingTracer=row.name==='pure-steam-donor'?0:basis.tracer_kg_eq
  const poolTracer=incomingTracer,gasTracer=0,partition=absorberPartition(row.final.mass_kg,poolTracer)
  check(row.name+' incoming tracer ledger',poolTracer+gasTracer===incomingTracer&&partition.dissolved+partition.retained===poolTracer)
  return {name:row.name,incomingTracer_kg_eq:incomingTracer,poolTracer_kg_eq:poolTracer,gasTracer_kg_eq:gasTracer,partition}
 })
 const dry=absorberPartition(0,basis.tracer_kg_eq),rewet=absorberPartition(result.refill.mass_kg,basis.tracer_kg_eq)
 // Separate abstract face-payload rule: not a native example of a liquid donor becoming all vapor.
 const allVaporPayload={scope:'Prescribed liquid-origin tracer payload at an all-vapor receiving face; not the native pure-steam donor',
  incomingTracer_kg_eq:basis.tracer_kg_eq,receivedLiquid_kg:0,retainedTracer_kg_eq:dry.retained,exportedTracer_kg_eq:0}
 check('prescribed all-vapor liquid-origin payload stays at dry finite receiver',
  allVaporPayload.retainedTracer_kg_eq+allVaporPayload.exportedTracer_kg_eq===allVaporPayload.incomingTracer_kg_eq&&dry.dissolved===0&&dry.liquidConcentration===null)
 check('actual refill remobilizes only available capacity',rewet.dissolved>0&&rewet.retained>0)
 const spill=transferLiquid({liquid:10,tracer:.2},{liquid:20,tracer:.01},1)
 const reverse=transferLiquid(spill.receiver,spill.donor,1)
 check('overflow carries mobile tracer not all donor residue',spill.transportedTracer===.01)
 check('backflow uses collection concentration',reverse.transportedTracer!==spill.transportedTracer)
 check('bidirectional spill retains total tracer',Math.abs(reverse.donor.tracer+reverse.receiver.tracer-.21)<1e-14)
 const crest=basis.tankFloor_m+basis.tankHeight_m,rho=result.initial.density_kg_m3
 const flows={atLip:signedSpill(crest,0,rho,rho,basis),forward:signedSpill(crest+.1,0,rho,rho,basis),
  equal:signedSpill(crest+.1,crest+.1,rho,rho,basis),backflow:signedSpill(crest,crest+.1,rho,result.saturatedLiquidDensity_kg_m3,basis)}
 check('lip equality has no overflow',flows.atLip===0)
 check('positive excess gives finite overflow',flows.forward>0&&Number.isFinite(flows.forward))
 check('equal backwater has zero transfer',flows.equal===0)
 check('higher collection backfloods with its native saturated donor density',flows.backflow<0&&Math.abs(flows.backflow+flows.forward*result.saturatedLiquidDensity_kg_m3/rho)<1e-10)
 const output={sources,calculationSha256:createHash('sha256').update(openPoolCalculation).digest('hex'),...result,
  tracer:{flashReceipts:flashTracer,allVaporPayload,dry,rewet,spill,reverse},spillRates_kg_s:flows}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:checks.length,receipts:result.receipts,spillRates_kg_s:flows}:output,null,2))
}

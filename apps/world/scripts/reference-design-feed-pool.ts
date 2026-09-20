/** Geometry-adapted reuse of the selected open-pool law; no feed-cycle transient. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {z} from 'zod'
import {openPoolCalculation,signedSpill} from './reference-design-inventory-open-pools'
import {absorberPartition,transferLiquid} from './reference-design-absorber-retention'
const positive=z.number().finite().positive(),finite=z.number().finite()
const schema=z.object({pressure_Pa:positive,gravity_m_s2:positive,tankArea_m2:positive,tankFloor_m:finite,
 tankHeight_m:positive,collectionArea_m2:positive,collectionFloor_m:finite,weirCoefficient:positive,
 initialTemperature_C:positive,initialLiquidVolume_m3:positive,condensatePort_m:finite,ventPort_m:finite,
 ambientTemperature_C:finite}).strict().refine(b=>b.initialLiquidVolume_m3<b.tankArea_m2*b.tankHeight_m&&
 b.collectionFloor_m<b.tankFloor_m+b.tankHeight_m&&b.condensatePort_m===b.tankFloor_m&&
 b.ambientTemperature_C> -273.15&&b.ventPort_m>=b.tankFloor_m&&b.ventPort_m<=b.tankFloor_m+b.tankHeight_m,'Inconsistent feed geometry')
export function parseFeedPool(text:string){
 const blocks=[...text.matchAll(/^```reference-feed-pool\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw new Error('Expected one feed-pool record')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function receivingPort(surface:number,port:number){
 if(!Number.isFinite(surface)||!Number.isFinite(port))throw new Error('Invalid port elevation')
 return {covered:surface>port,separationElevation:Math.max(surface,port)}
}
const portCalculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
b=json.load(sys.stdin);p=b['pressure_Pa'];g=b['gravity_m_s2'];A=b['tankArea_m2'];zf=b['tankFloor_m'];T0=b['initialTemperature_C']+273.15
Ts=P('T','P',p,'Q',0,'Water');hf=P('H','P',p,'Q',0,'Water');hg=P('H','P',p,'Q',1,'Water');rf=P('D','P',p,'Q',0,'Water');sf=P('S','P',p,'Q',0,'Water')
r0=P('D','P',p,'T',T0,'Water');M=b['initialLiquidVolume_m3']*r0;checks=[]
def check(n,ok):
 if not ok:raise ValueError(n)
 checks.append(n)
states=[]
for label,T,rho,h,s in [('cold',T0,r0,P('H','P',p,'T',T0,'Water'),P('S','P',p,'T',T0,'Water')),('same-mass-saturated',Ts,rf,hf,sf)]:
 depth=M/(rho*A);zs=zf+depth;PE=g*M*(zf+depth/2);H=h+g*zs
 def atPort(z):
  if zs<=z:return dict(covered=False,pressure=p,gasDonor='ambient air',temperature_C=b['ambientTemperature_C'])
  pp=brentq(lambda pp:P('H','P',pp,'S',s,'Water')+g*z-H,p,p+1e5,xtol=1e-5)
  hp=P('H','P',pp,'S',s,'Water');residual=hp+g*z-H;equivalent=residual*P('D','P',pp,'S',s,'Water')
  check(label+' fixed-state native port one-Pa screen '+str(z),abs(equivalent)<=1.)
  return dict(covered=True,pressure=pp,enthalpy=hp,totalEnthalpy=hp+g*z,headResidual_J_kg=residual,
   equivalentPressureResidual_Pa=equivalent,originalAbsoluteHeadScreenPassed=abs(residual)<1e-5,
   comparisonAllowance_Pa=1.,meaning='Fixed-state port/NPSH comparison only; not a runtime solver tolerance, pressure clamp or proof of smaller gradients')
 pv=P('P','T',T,'Q',1,'Water');head=(p-pv)/(rho*g)+zs
 states.append(dict(label=label,mass=M,T=T,depth=depth,surface=zs,PE=PE,totalSurfaceEnthalpy=H,bottom=atPort(b['condensatePort_m']),vent=atPort(b['ventPort_m']),liquidHeadNPSH=head))
check('Initial negative PE and unchanged reference surface',states[0]['PE']<0 and abs(states[0]['surface'])<1e-12)
check('Thermal level rise does not restore NPSH',states[1]['depth']>states[0]['depth'] and states[0]['liquidHeadNPSH']>5 and 0<states[1]['liquidHeadNPSH']<5)
check('Rising pool can submerge case vent',not states[0]['vent']['covered'] and states[1]['vent']['covered'])
# Independent frozen surface at the saturated state. Actual hydraulic inlet is bottom.
# Illustrative 100 kg water-carrier donor at7.2MPa/220C plus explicitly owned NC payloads.
zs=states[1]['surface'];mw=100.;Hwater=P('H','P',7.2e6,'T',493.15,'Water');hsep=Hwater-g*zs;x=(hsep-hf)/(hg-hf)
ml=mw*(1-x);mv=mw*x;liquid=ml*(hf+g*zs);steam=mv*(hg+g*zs)
gas=[]
for name,m,R,cv in [('air',.05,287.,718.),('nitrogen',.02,296.8,742.)]:
 Tin=493.15;Hin=cv*(Tin-298.15)+R*Tin;hface=Hin-g*zs;Tout=(hface+cv*298.15)/(cv+R)
 gas.append(dict(species=name,mass=m,incomingTotalEnthalpy=m*Hin,temperatureAtSeparation=Tout,exportTotalEnthalpy=m*(hface+g*zs)))
incoming=mw*Hwater+sum(a['incomingTotalEnthalpy'] for a in gas);export=steam+sum(a['exportTotalEnthalpy'] for a in gas)
check('Single surface flash of actual water total enthalpy',0<x<1 and abs(liquid+export-incoming)<1e-7)
check('Steam and both NC identities leave through actual atmosphere',mv>0 and all(a['mass']>0 and abs(a['incomingTotalEnthalpy']-a['exportTotalEnthalpy'])<1e-10 for a in gas))
excess=liquid-(hf+g*zs)*ml
check('Saturated receipt does not count flashed latent energy again',abs(excess)<1e-8)
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),states=states,mixedReceipt=dict(scope='Assembled native water plus independent ideal-air/N2 constituent payloads at a frozen saturated receiving surface; not a common upstream mixture EOS state, solved pump delivery or pool trajectory',waterMass=mw,liquidMass=ml,steamMass=mv,waterTotalEnthalpy=Hwater,separationElevation=zs,separationEnthalpy=hsep,liquidEnergy=liquid,gasEnergy=export,incomingEnergy=incoming,NC=gas,secondaryBoilingEnergy=excess),checks=checks)))
`
if(import.meta.main){
 const [owner,python,receipt,...extra]=process.argv.slice(2)
 if(!owner||!python||extra.length)throw new Error('Usage: <feed-index.md> <python-with-CoolProp> [receipt.json]')
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
 const sources=[owner,import.meta.path,resolve(import.meta.dir,'reference-design-inventory-open-pools.ts'),resolve(import.meta.dir,'reference-design-absorber-retention.ts')].map(path=>({path,sha256:hash(path)}))
 const b=parseFeedPool(readFileSync(owner,'utf8'));const width=4*Math.sqrt(b.tankArea_m2)
 // The shared helper's receiptPort is the frozen initial separation plane, not hydraulic nozzle elevation.
 const basis={...b,weirWidth_m:width,initialReceiverVolume_m3:b.initialLiquidVolume_m3,
  receiptPort_m:b.tankFloor_m+b.initialLiquidVolume_m3/b.tankArea_m2,parcelMass_kg:100,
  nominalPressure_MPa:.101325,nominalTemperature_C:40,hotPressure_MPa:7.2,hotTemperature_C:220,
  boilEnergy_J:100000,dryMass_kg:1,tracer_kg_eq:.2}
 const run=(script:string,input:unknown)=>{
  const result=spawnSync(python,['-c',script],{input:JSON.stringify(input),encoding:'utf8'})
  if(result.status!==0)throw new Error(result.stderr||'Feed-pool native comparison failed')
  return JSON.parse(result.stdout)
 }
 const pool=run(openPoolCalculation,basis),ports=run(portCalculation,b);const checks:string[]=[...pool.checks,...ports.checks]
 const check=(n:string,ok:boolean)=>{if(!ok)throw new Error(n);checks.push(n)}
 const crest=b.tankFloor_m+b.tankHeight_m,rho=pool.initial.density_kg_m3
 const whole=signedSpill(crest+.1,b.collectionFloor_m,rho,rho,basis),half=signedSpill(crest+.1,b.collectionFloor_m,rho,rho,{...basis,weirWidth_m:width/2})
 const reverse=signedSpill(crest,crest+.1,rho,pool.saturatedLiquidDensity_kg_m3,basis)
 check('Whole rim finite capacity and half-obstruction consequence',whole>0&&half===whole/2)
 check('Equal backwater stalls spill',signedSpill(crest+.1,crest+.1,rho,rho,basis)===0)
 check('Actual hot collection can backflood',reverse<0)
 const dry=absorberPartition(0,.2),refill=absorberPartition(10,.2),spill=transferLiquid({liquid:10,tracer:.2},{liquid:20,tracer:.01},1),back=transferLiquid(spill.receiver,spill.donor,1)
 check('Dry tracer retained and refill only remobilizes capacity',dry.retained===.2&&dry.dissolved===0&&refill.dissolved===.1&&refill.retained===.1)
 check('Opposite spill carries actual mobile donor tracer',spill.transportedTracer===.01&&back.transportedTracer!==spill.transportedTracer&&Math.abs(back.donor.tracer+back.receiver.tracer-.21)<1e-12)
 check('Pure steam receiving coupon does not supply liquid',pool.receipts.find((r:{name:string})=>r.name==='pure-steam-donor').liquidReceipt_kg===0)
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
 const output={scope:'Reused geometry-adapted open-pool coupons plus native port, frozen mixed receipt and rim/backwater comparison; no installed transient or boiling duration',sources,basis:b,couponBasis:basis,openPool:pool,ports,rim:{width,whole_kg_s:whole,half_kg_s:half,reverse_kg_s:reverse},tracer:{dry,refill,spill,back},checks}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:checks.length,initial:pool.initial,ports:ports.states,mixedReceipt:ports.mixedReceipt,rim:output.rim}:output,null,2))
}

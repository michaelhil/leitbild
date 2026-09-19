/** Frozen charging pressure/capacity selection; no installed transient or live model. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {z} from 'zod'
import {readServicePump} from './reference-design-service-pump-continuation'

const positive=z.number().finite().positive()
const schema=z.object({bodyResidence_s:positive,equipmentPressure_MPa:positive,equipmentTemperature_C:positive,
 openingDifferential_MPa:positive,reseatDifferential_MPa:positive,maximumCdA_m2:positive,stroke_s:positive,
 receiverPressures_MPa:z.array(positive).length(2),retainedHotPressure_MPa:positive,retainedHotTemperature_C:positive,
}).strict().refine(b=>b.reseatDifferential_MPa<b.openingDifferential_MPa&&b.retainedHotPressure_MPa<b.equipmentPressure_MPa
 &&b.retainedHotTemperature_C<b.equipmentTemperature_C,'Inconsistent charging pressure selection')
export function parseChargingPressure(document:string){
 const blocks=[...document.matchAll(/^```reference-charging-pressure\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw new Error('Expected one charging-pressure record')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function chargingReliefDemand(differential_MPa:number,retained:boolean,b:ReturnType<typeof parseChargingPressure>){
 if(!Number.isFinite(differential_MPa))throw new Error('Nonfinite relief pressure')
 return differential_MPa>=b.openingDifferential_MPa?true:differential_MPa<=b.reseatDifferential_MPa?false:retained
}
export const chargingPressureCalculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp import AbstractState
from CoolProp.CoolProp import PT_INPUTS,PSmass_INPUTS,HmassP_INPUTS
from scipy.optimize import minimize_scalar
v=json.load(sys.stdin);b=v['pressure'];pump=v['pump'];checks=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
w=AbstractState('HEOS','Water');throat=AbstractState('HEOS','Water')
def state(p,T):
 w.update(PT_INPUTS,p,T)
 return dict(p=p,T=T,rho=w.rhomass(),h=w.hmass(),s=w.smass(),u=w.umass())
pin=pump['inletPressure_MPa']*1e6;dp0=(pump['outletPressure_MPa']-pump['inletPressure_MPa'])*1e6
ref=state(pin,pump['inletTemperature_C']+273.15);V=b['bodyResidence_s']*pump['flow_kg_s']/ref['rho']
shutoff=pin+1.25*dp0
def native_nozzle(donor,receiver):
 def flux(p):
  throat.update(PSmass_INPUTS,p,donor['s']);dh=donor['h']-throat.hmass()
  if dh < -1e-5:raise ValueError('Negative native nozzle energy')
  return throat.rhomass()*math.sqrt(2*max(dh,0))
 result=minimize_scalar(lambda p:-flux(p),bounds=(receiver,donor['p']),method='bounded',options={'xatol':.01})
 boundary=flux(receiver)
 return dict(flux=max(boundary,-result.fun),throatPressure=receiver if boundary>=-result.fun else result.x)
rows=[]
for receiverMPa in b['receiverPressures_MPa']:
 receiver=receiverMPa*1e6;body=receiver+b['openingDifferential_MPa']*1e6
 # Healthy check closes when reference pump shutoff cannot reach the body. This is not a signed pump law.
 ratio=math.sqrt((1.25-(body-pin)/dp0)/.25) if body<shutoff else 0.
 incoming=pump['flow_kg_s']*ratio
 w.update(PSmass_INPUTS,body,ref['s']);work=w.hmass()-ref['h']
 faceH=ref['h']+work/pump['hydraulicEfficiency'];w.update(HmassP_INPUTS,faceH,body)
 donors=[('cold-pump-face',state(body,w.T())),('retained-hot-body',state(body,b['retainedHotTemperature_C']+273.15))]
 for label,donor in donors:
  nozzle=native_nozzle(donor,receiver);full=b['maximumCdA_m2']*nozzle['flux']
  # A frozen parcel ledger checks donor total enthalpy, not a time-to-depletion prediction.
  parcel=.01*donor['rho']*V;initialM=donor['rho']*V;initialU=initialM*donor['u'];export=parcel*donor['h']
  remainingM=initialM-parcel;remainingU=initialU-export
  check(label+' positive remaining native water',remainingM>0 and remainingU>0)
  check(label+' frozen parcel single energy incidence',abs(remainingU+export-initialU)<1e-7)
  check(label+' positive pressure-driven capacity',full>0 and incoming>=0)
  rows.append(dict(receiver_MPa=receiverMPa,body_MPa=body/1e6,donor=label,temperature_C=donor['T']-273.15,
   possibleColdPumpInflow_kg_s=incoming,fullLiftRelief_kg_s=full,capacityRatio=full/incoming if incoming else None,
   fullLiftExceedsColdPumpInflow=bool(full>incoming),throatPressure_MPa=nozzle['throatPressure']/1e6,
   donorEnthalpy_J_kg=donor['h'],initialMass_kg=initialM,parcelMass_kg=parcel,parcelEnergy_J=export))
check('nominal discharge does not demand relief',pump['outletPressure_MPa']-b['receiverPressures_MPa'][0]<b['openingDifferential_MPa'])
check('reference shutoff below selected equipment envelope',shutoff/1e6<b['equipmentPressure_MPa'])
check('cold full-lift capacity exceeds achievable cold-pump inflow',all(r['fullLiftExceedsColdPumpInflow'] for r in rows if r['donor']=='cold-pump-face'))
preparations=[]
for name,p,T in [('cold-isolated',pin,pump['inletTemperature_C']+273.15),('retained-primary-hot',b['retainedHotPressure_MPa']*1e6,b['retainedHotTemperature_C']+273.15)]:
 a=state(p,T);M=a['rho']*V
 preparations.append(dict(name=name,pressure_MPa=p/1e6,temperature_C=T-273.15,volume_m3=V,mass_kg=M,internalEnergy_J=M*a['u']))
check('hot isolated preparation not silently cold-reset',preparations[1]['internalEnergy_J']>preparations[0]['internalEnergy_J'])
print(json.dumps(dict(scope='Frozen native-water full-lift capacity and independent retained-body preparations; no lift/pressure trajectory, gas discharge, installed protection or thermal-expansion qualification',
 libraries={'CoolProp':CoolProp.__version__,'SciPy':scipy.__version__},basis=v,bodyVolume_m3=V,referenceShutoff_MPa=shutoff/1e6,
 rows=rows,preparations=preparations,checks=checks)))
`
if(import.meta.main){
 const [owner,python,receipt,...extra]=Bun.argv.slice(2)
 if(!owner||!python||extra.length)throw new Error('Usage: <inventory-owner.md> <python-with-CoolProp> [receipt.json]')
 const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
 const paths=[owner,import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-continuation.ts')]
 const sources=paths.map(path=>({path,sha256:hash(path)}))
 const pressure=parseChargingPressure(readFileSync(owner,'utf8')),pump=readServicePump(owner)
 if(pump.id!=='CHARGE')throw new Error('Expected charging pump owner')
 const input={pressure,pump}
 const result=spawnSync(python,['-c',chargingPressureCalculation],{input:JSON.stringify(input),encoding:'utf8'})
 if(result.status!==0)throw new Error(result.stderr||'Charging pressure comparison failed')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
 const calculation=JSON.parse(result.stdout)
 const output={sources,calculationSha256:createHash('sha256').update(chargingPressureCalculation).digest('hex'),...calculation}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:output.checks.length,bodyVolume_m3:output.bodyVolume_m3,rows:output.rows}:output,null,2))
}

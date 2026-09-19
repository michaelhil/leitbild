/** Offline local-relief mechanics and finite liquid coupon, not an installed RHR transient. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseRhrPressureBasis } from './reference-design-rhr-pressure'
import { parseServicePump } from './reference-design-service-pump-continuation'

const positive = z.number().finite().positive()
const schema = z.object({
  openingDifferential_MPa: positive, reseatDifferential_MPa: positive,
  maximumCdA_m2: positive, stroke_s: positive, strokeSensitivity_s: z.array(positive).length(3),
  couponInitialPressure_MPa: positive, couponTemperatures_C: z.array(positive).length(2),
  receiverPressures_MPa: z.array(positive).length(2), couponDuration_s: positive,
}).strict().superRefine((b, c) => {
  if (!(b.reseatDifferential_MPa < b.openingDifferential_MPa)
    || !b.strokeSensitivity_s.includes(b.stroke_s)
    || b.receiverPressures_MPa.some(p => p >= b.couponInitialPressure_MPa))
    c.addIssue({ code: 'custom', message: 'Invalid local relief differential, time or receiving pressure' })
})

export function parseRhrLocalRelief(document: string) {
  const blocks = [...document.matchAll(/^```reference-rhr-local-relief\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-rhr-local-relief block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Pure retained mechanics: hysteresis selects travel, never directly deletes actual lift. */
export function localReliefDemand(dpMPa: number, released: boolean, basis: ReturnType<typeof parseRhrLocalRelief>) {
  if (!Number.isFinite(dpMPa)) throw new Error('Nonfinite differential pressure')
  return dpMPa >= basis.openingDifferential_MPa ? true : dpMPa <= basis.reseatDifferential_MPa ? false : released
}
export function advanceReliefLift(lift: number, released: boolean, seconds: number, stroke: number) {
  if (![lift, seconds, stroke].every(Number.isFinite) || lift < 0 || lift > 1 || seconds < 0 || stroke <= 0)
    throw new Error('Invalid retained mechanical state')
  const travelTime = (released ? 1 - lift : lift) * stroke
  if (seconds >= travelTime) return released ? 1 : 0
  return released ? lift + seconds / stroke : lift - seconds / stroke
}

export const localReliefCalculation = String.raw`
import json,sys,platform,math
import numpy as np
import scipy,CoolProp
from CoolProp import AbstractState
from CoolProp.CoolProp import PT_INPUTS,PSmass_INPUTS,iDmass,iUmass,iP,iT
from scipy.integrate import solve_ivp,quad
from scipy.optimize import minimize_scalar
b=json.load(sys.stdin);v=b['relief'];p=b['pressure'];pump=b['pump']
fluid=AbstractState('HEOS','Water');isent=AbstractState('HEOS','Water')
def water(pa,T):
 fluid.update(PT_INPUTS,float(pa),float(T))
 if not fluid.phase() in (0,3):raise ValueError('Local relief coupon outside liquid domain')
 rho=fluid.rhomass();u=fluid.umass()
 rp=fluid.first_partial_deriv(iDmass,iP,iT);rt=fluid.first_partial_deriv(iDmass,iT,iP)
 up=fluid.first_partial_deriv(iUmass,iP,iT);ut=fluid.first_partial_deriv(iUmass,iT,iP)
 return dict(p=pa,T=T,rho=rho,u=u,h=fluid.hmass(),s=fluid.smass(),rp=rp,rt=rt,up=up,ut=ut)
ref=water(pump['inletPressure_MPa']*1e6,pump['inletTemperature_C']+273.15)
r0=ref['rho'];V=.05*pump['flow_kg_s']/r0
head=p['pumpReferenceRise_MPa']*1.25/(1+.25*p['pumpReferenceRise_MPa']/p['minimumFlowReferenceDrop_MPa']*(p['minimumFlowReference_kg_s']/p['pumpReferenceTotal_kg_s'])**2)
minimum=p['minimumFlowReference_kg_s']*math.sqrt(head/p['minimumFlowReferenceDrop_MPa'])
isent.update(PSmass_INPUTS,(pump['inletPressure_MPa']+head)*1e6,ref['s'])
work=isent.hmass()-ref['h'];heat=minimum*work/pump['hydraulicEfficiency']
def specific_volume(pp,ss):
 isent.update(PSmass_INPUTS,float(pp),float(ss));return 1/isent.rhomass()
integral=quad(lambda pp:specific_volume(pp,ref['s']),ref['p'],ref['p']+head*1e6,epsabs=1e-7)[0]
if abs(work-integral)>1e-5:raise ValueError('Independent native work discrepancy')
def nozzle(w,receiver):
 if receiver>=w['p']:return 0.
 def flux(pp):
  isent.update(PSmass_INPUTS,float(pp),w['s']);dh=w['h']-isent.hmass()
  if dh < -1e-5:raise ValueError('Negative nozzle energy')
  return isent.rhomass()*math.sqrt(2*max(dh,0.))
 result=minimize_scalar(lambda pp:-flux(pp),bounds=(receiver,w['p']),method='bounded',options={'xatol':.01})
 return max(flux(receiver),-result.fun)
def run(Tc,receiver_MPa,stroke,failed=False,refined=False):
 receiver=receiver_MPa*1e6;initial=water(v['couponInitialPressure_MPa']*1e6,Tc+273.15)
 M0=initial['rho']*V;U0=M0*initial['u'];state=np.array([initial['p'],initial['T'],0.,0.,0.])
 time=0.;released=False;rows=[(time,state.copy())];events=[];reached=False
 while time<v['couponDuration_s']-1e-12:
  mode=0 if failed else (1 if released and state[2]<1 else -1 if not released and state[2]>0 else 0)
  def rhs(t,y):
   w=water(y[0],y[1]);lift=max(0.,min(1.,y[2]))
   mass=v['maximumCdA_m2']*lift*nozzle(w,receiver) if lift>0 else 0.
   energy=mass*w['h']
   jac=V*np.array([[w['rp'],w['rt']],[w['u']*w['rp']+w['rho']*w['up'],w['u']*w['rt']+w['rho']*w['ut']]])
   rates=np.linalg.solve(jac,np.array([-mass,heat-energy]))
   return [rates[0],rates[1],mode/stroke,mass,energy]
  def limit(t,y):return y[0]-p['dischargeEnvelope_MPa']*1e6
  limit.terminal=True;limit.direction=1
  def trigger(t,y):return y[0]-receiver-(v['reseatDifferential_MPa'] if released else v['openingDifferential_MPa'])*1e6
  trigger.terminal=True;trigger.direction=-1 if released else 1
  es=[limit];labels=['equipment limit']
  if not failed:es.append(trigger);labels.append('reseat demand' if released else 'opening demand')
  if mode:
   endpoint=1. if mode==1 else 0.
   def travel(t,y):return y[2]-endpoint
   travel.terminal=True;travel.direction=mode
   es.append(travel);labels.append('open stop' if mode==1 else 'closed stop')
  sol=solve_ivp(rhs,(time,v['couponDuration_s']),state,method='Radau',rtol=2e-9 if refined else 1e-8,
   atol=[.001,1e-9,1e-12,1e-11,1e-5],max_step=.0025 if refined else .005,events=es)
  if not sol.success:raise ValueError(sol.message)
  rows.extend((float(t),y.copy()) for t,y in zip(sol.t[1:],sol.y.T[1:]));newtime=float(sol.t[-1]);state=sol.y[:,-1].copy()
  hit=next((i for i,x in enumerate(sol.t_events) if len(x)),None)
  if hit is None:time=newtime;break
  if newtime<=time+1e-14:raise ValueError('Unresolved repeated mechanical event')
  events.append(dict(time_s=newtime,event=labels[hit],pressure_MPa=float(state[0]/1e6),lift=float(state[2])))
  time=newtime
  if hit==0:reached=True;break
  if labels[hit]=='opening demand':released=True
  elif labels[hit]=='reseat demand':released=False
  elif labels[hit]=='open stop':state[2]=1.
  elif labels[hit]=='closed stop':state[2]=0.
  if len(events)>1000:raise ValueError('Bounded coupon event budget exceeded')
 massError=energyError=0.;liftAdmissible=True
 for t,y in rows:
  liftAdmissible=liftAdmissible and -1e-12<=y[2]<=1+1e-12
  w=water(y[0],y[1]);massError=max(massError,abs(w['rho']*V+y[3]-M0))
  energyError=max(energyError,abs(w['rho']*V*w['u']+y[4]-U0-heat*t))
 final=water(state[0],state[1]);maxPressure=max(y[0] for _,y in rows)/1e6
 return dict(temperature_C=Tc,receiver_MPa=receiver_MPa,stroke_s=stroke,failedClosed=failed,refined=refined,
  acceptedTime_s=time,pressureLimitReached=reached,sampledMaximumPressure_MPa=maxPressure,finalPressure_MPa=float(state[0]/1e6),
  finalTemperature_C=float(state[1]-273.15),finalLift=float(state[2]),released=released,dischargedMass_kg=float(state[3]),
  dischargedEnergy_J=float(state[4]),maximumMassDefect_kg=massError,maximumEnergyDefect_J=energyError,events=events,
  checks=dict(nativeMass=bool(massError<1e-7),nativeEnergy=bool(energyError<.1),finiteWater=bool(final['rho']*V>0),acceptedLift=bool(liftAdmissible),
   expectedPhysicalOutcome=reached if failed or receiver_MPa==v['receiverPressures_MPa'][1] else not reached))
cases=[run(T,r,v['stroke_s']) for T in v['couponTemperatures_C'] for r in v['receiverPressures_MPa']]
cases+=[run(v['couponTemperatures_C'][1],v['receiverPressures_MPa'][0],s) for s in v['strokeSensitivity_s'] if s!=v['stroke_s']]
cases+=[run(v['couponTemperatures_C'][1],v['receiverPressures_MPa'][0],v['stroke_s'],failed=True),
 run(v['couponTemperatures_C'][1],v['receiverPressures_MPa'][0],v['stroke_s'],refined=True)]
base=cases[2];fine=cases[-1]
comparison=dict(sampledMaximumPressure_Pa=abs(base['sampledMaximumPressure_MPa']-fine['sampledMaximumPressure_MPa'])*1e6,
 finalPressure_Pa=abs(base['finalPressure_MPa']-fine['finalPressure_MPa'])*1e6,
 dischargedMass_kg=abs(base['dischargedMass_kg']-fine['dischargedMass_kg']),eventCountEqual=len(base['events'])==len(fine['events']))
comparison['accepted']=comparison['sampledMaximumPressure_Pa']<100 and comparison['finalPressure_Pa']<100 and comparison['dischargedMass_kg']<1e-6 and comparison['eventCountEqual']
print(json.dumps(dict(scope='Finite uniform hypothetical relief-side liquid coupon; casing-sized volume, prescribed frozen MINFLOW work as heater, fixed receiver pressure, no installed pump/HX/containment trajectory',
 python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,basis=b,
 couponVolume_m3=V,prescribedHeat_W=heat,referenceMinimumFlow_kg_s=minimum,referenceHead_MPa=head,
 referenceIsentropicWork_J_kg=work,independentWorkIntegral_J_kg=integral,cases=cases,refinement=comparison,
 accepted=all(all(c['checks'].values()) for c in cases) and comparison['accepted']),allow_nan=False))
`

export async function runRhrLocalRelief(document: string, python: string) {
  const relief = parseRhrLocalRelief(document), pressure = parseRhrPressureBasis(document), pump = parseServicePump(document)
  if (pump.id !== 'RHR') throw new Error('Expected RHR pump owner')
  const input = JSON.stringify({ relief, pressure, pump })
  const child = Bun.spawn([python, '-c', localReliefCalculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Local relief coupon failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(localReliefCalculation), sourceSha256: hash(await Bun.file(import.meta.path).text()) }
}
if (import.meta.main) {
  const [owner, python, receipt, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || extra.length) throw new Error('Usage: bun reference-design-rhr-local-relief.ts <RHR-owner.md> <python-with-CoolProp> [receipt.json]')
  const result = await runRhrLocalRelief(await Bun.file(owner).text(), python)
  if (receipt) await Bun.write(receipt, JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify(receipt ? {receipt, accepted:result.accepted, cases:result.cases.length, heat_W:result.prescribedHeat_W, refinement:result.refinement} : result, null, 2))
}

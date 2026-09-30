/** Native finite-water cold relief coupon. No installed plant or fracture qualification. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({
  opening_Pa: positive, reseat_Pa: positive, limit_Pa: positive, reliefArea_m2: positive, isolationArea_m2: positive,
  stroke_s: positive, volume_m3: positive, initialPressure_Pa: positive,
  temperatures_K: z.array(positive).length(2), inflow_kg_s: positive,
  inletTemperature_K: positive, heat_W: z.array(positive).length(2),
  receivers_Pa: z.array(positive).length(2), duration_s: positive,
  coldPzr: z.object({ temperature_K: positive, hotPressure_Pa: positive, liquidPreparationHeight_m: positive }).strict(),
}).strict().superRefine((b, ctx) => {
  if (!(b.initialPressure_Pa < b.reseat_Pa && b.reseat_Pa < b.opening_Pa && b.opening_Pa < b.limit_Pa)
    || b.temperatures_K.some(t => t < 300 || t > 433.15)
    || b.inletTemperature_K < 300 || b.inletTemperature_K > 433.15
    || b.receivers_Pa.some(p => p >= b.limit_Pa) || b.coldPzr.temperature_K < 300 || b.coldPzr.temperature_K > 433.15
    || b.coldPzr.liquidPreparationHeight_m < 3 || b.coldPzr.liquidPreparationHeight_m >= 12)
    ctx.addIssue({ code: 'custom', message: 'Invalid declared cold liquid coupon or pressure sequence' })
})
export function parseColdPressure(document: string) {
  const blocks = [...document.matchAll(/^```reference-cold-pressure\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cold-pressure block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Explicit zero-storage assembly reduction, not a two-stage flashing solve. */
export function coldReliefAssemblyArea(reliefArea: number, reliefLift: number, isolationArea: number, isolationPosition: number) {
  if (![reliefArea, reliefLift, isolationArea, isolationPosition].every(Number.isFinite)
    || reliefArea <= 0 || isolationArea <= 0 || reliefLift < 0 || reliefLift > 1 || isolationPosition < 0 || isolationPosition > 1)
    throw new Error('Invalid physical assembly aperture')
  if (reliefLift === 0 || isolationPosition === 0) return 0
  return 1 / Math.hypot(1 / (reliefArea * reliefLift), 1 / (isolationArea * isolationPosition))
}

/** Explicit projection boundary. Caller supplies b, P, solve_ivp and math; emits preparation. */
export const coldPzrPreparationPython = String.raw`# Original cold centroid projection onto the existing ten PZR regions. Not static equilibrium.
c=b['coldPzr'];T=c['temperature_K'];g=9.80665;bottom=6.5;top=18.5;interface=bottom+c['liquidPreparationHeight_m']
pv=P('P','T',T,'Q',1,'Water');rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water')
liquidSeed=solve_ivp(lambda z,p:[-g*P('D','P',float(p[0]),'T',T,'Water')],(2.5,interface),[c['hotPressure_Pa']],rtol=1e-11,atol=1e-5,dense_output=True)
if not liquidSeed.success:raise ValueError('Cold hydrostatic seed failure')
gasSeed=solve_ivp(lambda z,p:[-g*(rv+(p[0]-pv)/(287*T))],(interface,top),[float(liquidSeed.y[0,-1])],rtol=1e-11,atol=1e-5,dense_output=True)
if not gasSeed.success:raise ValueError('Cold gas seed failure')
def pressureSeed(z):return float(liquidSeed.sol(z)[0]) if z<=interface else float(gasSeed.sol(z)[0])
regions=[]
for lo,hi in zip([0.,1.,3.,6.,9.],[1.,3.,6.,9.,12.]):
 z=bottom+(lo+hi)/2;p=pressureSeed(z);alpha=min(hi,max(lo,c['liquidPreparationHeight_m']))-lo;alpha/=hi-lo
 for lane,area in [('inner',.5),('outer',4.5)]:
  rods=(32*math.pi*.01**2*max(0.,min(hi,1.)-lo)+256*math.pi*.01**2*max(0.,min(hi,3.)-lo)) if lane=='inner' else 0.
  volume=area*(hi-lo)-rods;Vl=area*(hi-lo)*alpha-rods;Vg=volume-Vl
  if min(Vl,Vg)<-1e-12 or p<=pv:raise ValueError('Inadmissible cold native PZR projection')
  ml=P('D','P',p,'T',T,'Water')*Vl;ma=(p-pv)*Vg/(287*T);mv=rv*Vg
  U=ml*P('U','P',p,'T',T,'Water')+ma*718*(T-298.15)+mv*uv
  regions.append(dict(lane=lane,lo_m=lo,hi_m=hi,z_m=z,p_Pa=p,volume_m3=volume,liquid_kg=ml,air_kg=ma,steam_kg=mv,U_J=U,E_J=U+(ml+ma+mv)*g*z))
rhoL=P('D','P',15e6,'Q',0,'Water');rhoG=P('D','P',15e6,'Q',1,'Water')
pb=regions[1]['p_Pa'];pt=regions[-1]['p_Pa'];indication=((pb-pt)-rhoG*g*12)/((rhoL-rhoG)*g)
if not 3.5<=indication<=9.5:raise ValueError('Cold projected actual outer-trace LT outside selected reset band')
preparation=dict(regions=regions,actualOuterBottomTrace_Pa=pb,actualOuterTopTrace_Pa=pt,
 differentialIndication_m=indication,quantizedIndication_m=math.floor(indication/.01+.5)*.01,
 volume_m3=sum(r['volume_m3'] for r in regions),meaning='Existing fixed-region centroid projection; native retained water/air/steam, not exact discrete rest or an imposed running level')
`

export const coldPressureCalculation = String.raw`
import json,sys,platform,math
import numpy as np
import scipy,CoolProp
from CoolProp import AbstractState
from CoolProp.CoolProp import PT_INPUTS,PSmass_INPUTS,iDmass,iUmass,iP,iT,PropsSI as P
from scipy.integrate import solve_ivp
from scipy.optimize import minimize_scalar
b=json.load(sys.stdin);fluid=AbstractState('HEOS','Water');noz=AbstractState('HEOS','Water');inlet=AbstractState('HEOS','Water')
${coldPzrPreparationPython}def water(p,T):
 fluid.update(PT_INPUTS,float(p),float(T))
 if fluid.phase() not in (0,3):raise ValueError('Coupon outside admitted liquid domain')
 r=fluid.rhomass();u=fluid.umass()
 return r,u,fluid.hmass(),fluid.smass(),fluid.first_partial_deriv(iDmass,iP,iT),fluid.first_partial_deriv(iDmass,iT,iP),fluid.first_partial_deriv(iUmass,iP,iT),fluid.first_partial_deriv(iUmass,iT,iP)
def flux(p,h,s,receiver):
 if p<=receiver:return 0.
 def f(q):
  noz.update(PSmass_INPUTS,float(q),s);dh=h-noz.hmass()
  if dh < -1e-5:raise ValueError('Negative native nozzle work')
  return noz.rhomass()*math.sqrt(2*max(0.,dh))
 result=minimize_scalar(lambda q:-f(q),bounds=(receiver,p),method='bounded',options={'xatol':.1})
 if not result.success:raise ValueError('Nozzle maximum unresolved')
 return max(f(receiver),-result.fun)
def run(T,receiver,heat,failed=False,refined=False):
 V=b['volume_m3'];r,u,*_=water(b['initialPressure_Pa'],T);M0=r*V;U0=M0*u
 y=np.array([b['initialPressure_Pa'],T,0.,0.,0.,0.]);time=0.;lift=0.;released=False;rows=[(0.,y.copy(),0.)];events=[];reached=False
 while time<b['duration_s']-1e-11:
  direction=0 if failed else (1 if released and lift<1 else -1 if not released and lift>0 else 0)
  end=b['duration_s'] if direction==0 else min(b['duration_s'],time+(1-lift if direction==1 else lift)*b['stroke_s'])
  origin=time;startLift=lift
  def actualLift(t):return startLift+direction*(t-origin)/b['stroke_s']
  def rhs(t,v):
   r,u,h,s,rp,rt,up,ut=water(v[0],v[1]);L=actualLift(t)
   if not -1e-10<=L<=1+1e-10:raise ValueError('Mechanical interval outside stops')
   area=0. if L<=0 else 1/math.hypot(1/(b['reliefArea_m2']*L),1/b['isolationArea_m2'])
   out=area*flux(v[0],h,s,receiver) if area else 0.
   inlet.update(PT_INPUTS,float(v[0]),b['inletTemperature_K']);incoming=b['inflow_kg_s']*inlet.hmass()
   jac=V*np.array([[rp,rt],[u*rp+r*up,u*rt+r*ut]])
   rates=np.linalg.solve(jac,[b['inflow_kg_s']-out,heat+incoming-out*h])
   return [rates[0],rates[1],out,out*h,b['inflow_kg_s'],incoming]
  def limit(t,v):return v[0]-b['limit_Pa']
  limit.terminal=True;limit.direction=1
  es=[limit]
  if not failed:
   def trigger(t,v):return v[0]-(b['reseat_Pa'] if released else b['opening_Pa'])
   trigger.terminal=True;trigger.direction=-1 if released else 1
   es.append(trigger)
  sol=solve_ivp(rhs,(time,end),y,method='Radau',rtol=2e-9 if refined else 1e-8,
   atol=[.01,1e-9,1e-7,.01,1e-7,.01],max_step=.1 if refined else .2,events=es)
  if not sol.success:raise ValueError(sol.message)
  rows.extend((float(t),v.copy(),actualLift(t)) for t,v in zip(sol.t[1:],sol.y.T[1:]))
  t=float(sol.t[-1]);y=sol.y[:,-1].copy();lift=actualLift(t)
  hit=next((i for i,e in enumerate(sol.t_events) if len(e)),None)
  if t<=time+1e-13:raise ValueError('Unresolved repeated event')
  time=t
  if hit==0:reached=True;events.append({'time_s':t,'event':'administrative limit','pressure_Pa':float(y[0]),'lift':lift});break
  if hit==1:released=not released;label='opening demand' if released else 'reseat demand'
  elif direction and end<b['duration_s']+1e-11:lift=1. if direction==1 else 0.;label='open stop' if direction==1 else 'closed stop'
  else:break
  events.append({'time_s':t,'event':label,'pressure_Pa':float(y[0]),'lift':lift})
 massDefect=energyDefect=0.
 for t,v,L in rows:
  r,u,*_=water(v[0],v[1]);massDefect=max(massDefect,abs(r*V+v[2]-v[4]-M0));energyDefect=max(energyDefect,abs(r*V*u+v[3]-v[5]-heat*t-U0))
 return dict(initialTemperature_K=T,receiver_Pa=receiver,heat_W=heat,failedClosed=failed,refined=refined,
  acceptedTime_s=time,limitReached=reached,sampledMaximumPressure_Pa=max(v[0] for t,v,L in rows),finalPressure_Pa=float(y[0]),finalTemperature_K=float(y[1]),
  finalLift=lift,dischargedMass_kg=float(y[2]),dischargedEnthalpy_J=float(y[3]),addedMass_kg=float(y[4]),addedEnthalpy_J=float(y[5]),events=events,
  maximumMassDefect_kg=massDefect,maximumEnergyDefect_J=energyDefect,
  checks={'nativeMass':bool(massDefect<.001),'nativeEnergy':bool(energyDefect<100.),'finiteWater':bool(water(y[0],y[1])[0]*V>0.),'finiteTravel':bool(all(-1e-10<=L<=1+1e-10 for t,v,L in rows))})
cases=[run(T,R,Q) for T in b['temperatures_K'] for R in b['receivers_Pa'] for Q in b['heat_W']]
cases.append(run(b['temperatures_K'][1],b['receivers_Pa'][0],b['heat_W'][1],failed=True))
cases.append(run(b['temperatures_K'][1],b['receivers_Pa'][0],b['heat_W'][1],refined=True))
base=cases[5];fine=cases[-1]
comparison={'finalPressure_Pa':abs(base['finalPressure_Pa']-fine['finalPressure_Pa']),'dischargedMass_kg':abs(base['dischargedMass_kg']-fine['dischargedMass_kg']),
 'sampledPeakPressure_Pa':abs(base['sampledMaximumPressure_Pa']-fine['sampledMaximumPressure_Pa']),
 'eventTimes_s':max(abs(a['time_s']-c['time_s']) for a,c in zip(base['events'],fine['events'])) if len(base['events'])==len(fine['events']) else None}
comparison['accepted']=comparison['finalPressure_Pa']<100 and comparison['sampledPeakPressure_Pa']<100 and comparison['dischargedMass_kg']<.01 and comparison['eventTimes_s'] is not None and comparison['eventTimes_s']<.001
nominal=all(not c['limitReached'] for c in cases[:8] if c['receiver_Pa']==b['receivers_Pa'][0])
print(json.dumps(dict(scope='Uniform finite liquid coupon with prescribed inflow/heat and fixed receiver; not installed RCS, finite CNV, fracture or full startup qualification',
 python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,basis=b,coldPzr=preparation,cases=cases,refinement=comparison,
 accepted=bool(all(all(c['checks'].values()) for c in cases) and nominal and cases[-2]['limitReached'] and comparison['accepted'])),allow_nan=False))
`
export async function runColdPressure(document: string, python: string) {
  const input = JSON.stringify(parseColdPressure(document))
  const child = Bun.spawn([python, '-c', coldPressureCalculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Cold pressure coupon failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(coldPressureCalculation), sourceSha256: hash(await Bun.file(import.meta.path).text()) }
}
if (import.meta.main) {
  const [owner, python, receipt, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || extra.length) throw new Error('Usage: bun reference-design-cold-pressure.ts <owner.md> <python-with-CoolProp> [receipt.json]')
  const result = await runColdPressure(await Bun.file(owner).text(), python)
  if (receipt) await Bun.write(receipt, JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify(receipt ? { receipt, accepted: result.accepted, refinement: result.refinement,
    cases: result.cases.map((c: any) => ({ T: c.initialTemperature_K, receiver: c.receiver_Pa, heat: c.heat_W, failed: c.failedClosed, limit: c.limitReached, maximum: c.sampledMaximumPressure_Pa })) } : result, null, 2))
}

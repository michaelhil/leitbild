/** Offline finite RHR/support heat-path reference. No live runtime or plant initializer. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runSupport, selectSupportPoint, parseSupportBasis } from './reference-design-support-network'
import { parseStationBasis, pumpDuty } from './reference-design-station'

const positive = z.number().finite().positive()
const schema = z.object({ primaryInlet_C: positive, primaryOutlet_C: positive, primaryPressure_MPa: positive,
  primaryFlow_kg_s: positive, primaryPumpTotal_kg_s: positive, primaryPumpHead_MPa: positive,
  primaryHydraulicEfficiency: positive.max(1), primaryMotorEfficiency: positive.max(1), primaryDragFraction: z.number().finite().nonnegative(),
  referenceWall_C: positive, referenceColdInlet_C: positive, referenceColdFlow_kg_s: positive,
  primaryPipe_m3: positive, primaryHX_m3: positive, rhrWall_MJ_K: positive, rhrCold_m3: positive,
  supply_m3: positive, return_m3: positive, cooler_m3: positive, supportWall_MJ_K: positive, sw_m3: positive,
}).strict().refine(b => b.primaryInlet_C > b.primaryOutlet_C && b.primaryOutlet_C > b.referenceWall_C && b.referenceWall_C > b.referenceColdInlet_C, 'Ordered reference temperatures required')
  .refine(b => b.primaryPumpTotal_kg_s >= b.primaryFlow_kg_s, 'Total pump flow cannot be less than external delivery')
export function parseRhrSupport(page: string) {
  const blocks = [...page.matchAll(/^```reference-rhr-support\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-rhr-support record')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
async function pythonJson(python: string, source: string, payload: unknown) {
  const child = Bun.spawn([python, '-c', source], { stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exit) throw Error(err)
  return JSON.parse(out)
}
const properties = String.raw`
import json,sys
from iapws import IAPWS97 as W
b=json.load(sys.stdin)
hi=W(P=b['primaryPressure_MPa'],T=b['primaryInlet_C']+273.15);lo=W(P=b['primaryPressure_MPa'],T=b['primaryOutlet_C']+273.15)
mid=W(P=b['primaryPressure_MPa'],T=(hi.T+lo.T)/2)
if any(x.region!=1 for x in [hi,lo,mid]):raise ValueError('Reference must be liquid')
print(json.dumps(dict(duty_MW=b['primaryFlow_kg_s']*(hi.h-lo.h)/1000,cpHot_MJ_kgK=(hi.h-lo.h)/(hi.T-lo.T)/1000,rhoHot=mid.rho)))
`
const response = String.raw`
import json,sys,numpy as np,scipy,iapws
from scipy.linalg import expm
from scipy.integrate import solve_ivp
from scipy.optimize import brentq
from iapws import IAPWS97 as W
b=json.load(sys.stdin);r=b['basis'];s=b['station'];mat=b['materials'];rows=[]
cp=s['waterCp_J_kgK']/1e6;rho=s['waterDensity_kg_m3'];ch=mat['cpHot_MJ_kgK'];rh=mat['rhoHot']
# Fixed sizing masses/capacities, not fixed-volume IF97 transient inversion.
C=np.array([rh*r['primaryPipe_m3']*ch,rh*r['primaryHX_m3']*ch,r['rhrWall_MJ_K'],rho*r['rhrCold_m3']*cp,
 rho*r['supply_m3']*cp,rho*r['return_m3']*cp,rho*r['cooler_m3']*cp,r['supportWall_MJ_K'],rho*r['sw_m3']*cp])
names=['primaryPipe','primaryOutlet','rhrWall','rhrColdOutlet','ccwSupply','ccwReturn','ccwCooler','ccwWall','swOutlet']
def matrix(f,loss):
 p=f['point'];total=p['flow_kg_s'] if loss!='ccw' else 0.;mr=p['rhrFlow_kg_s'] if loss!='ccw' else 0.
 mh=p['hxFlow_kg_s'] if loss!='ccw' else 0.;mb=p['bypassFlow_kg_s'] if loss!='ccw' else 0.
 ms=b['swFlow_kg_s'] if loss!='sw' else 0.;pc=p['pump']['fluid_MW'] if loss!='ccw' else 0.;ps=f['swFluidHeat_MW'] if loss!='sw' else 0.
 hp=r['primaryFlow_kg_s']*ch;aux=f['auxiliaryHeat_MW'];A=np.zeros((9,9));v=np.zeros(9)
 def edge(i,j,g):
  A[i,i]-=g;A[i,j]+=g;A[j,j]-=g;A[j,i]+=g
 # Throughflows pay upstream enthalpy and their own receiving storage.
 A[0,0]-=hp;v[0]+=hp*f['hotInlet_C']+b['primaryPump']['fluid_MW'];A[1,0]+=hp;A[1,1]-=hp
 edge(1,2,b['hotConductance_MW_K']);edge(2,3,b['coldConductance_MW_K'])
 A[3,4]+=mr*cp;A[3,3]-=mr*cp;v[3]+=pc*mr/total if total else 0.
 A[4,6]+=mh*cp;A[4,5]+=mb*cp;A[4,4]-=total*cp
 A[5,3]+=mr*cp;A[5,4]+=(total-mr)*cp;A[5,5]-=total*cp;v[5]+=aux+(pc*(total-mr)/total if total else 0.)
 A[6,5]+=mh*cp;A[6,6]-=mh*cp;edge(6,7,b['supportConductance_MW_K']);edge(7,8,b['supportConductance_MW_K'])
 A[8,8]-=ms*cp;v[8]+=ms*cp*f['site_C']+ps
 # Independent external boundary: maintained primary stream, pump work, auxiliary deposition, site outlet.
 w=np.zeros(9);w[1]=-hp;w[8]=-ms*cp
 k=hp*f['hotInlet_C']+b['primaryPump']['fluid_MW']+aux+pc+ps+ms*cp*f['site_C']
 if max(abs(A.sum(axis=0)-w))>1e-12 or abs(v.sum()-k)>1e-12:raise ValueError('Internal heat/enthalpy exchanges do not cancel')
 L=np.zeros((11,11));L[:9,:9]=A/C[:,None];L[:9,10]=v/C;L[9,:9]=w;L[9,10]=k
 return L
for f in b['frames']:
 p=f['point'];q=f['heat_MW'];t=p['temperatures_C'];hp=r['primaryFlow_kg_s']*ch
 initial=np.array([f['hotInlet_C']+b['primaryPump']['fluid_MW']/hp,f['primaryOutlet_C'],f['wall_C'],p['rhrOutlet_C'],t['supply'],t['return'],t['coolerOutlet'],t['wall'],t['swOutlet'],0.,1.])
 base=matrix(f,'none');steady=max(abs((base@initial)[:9]));
 # Independent exact-enthalpy steady RHR check at achieved hydraulics/bypass; no adjustment of selected conductances.
 hin=W(P=r['primaryPressure_MPa'],T=f['hotInlet_C']+273.15).h+b['primaryPump']['fluid_MW']*1000/r['primaryFlow_kg_s']
 ci=W(P=.5,T=t['loadInlet']+273.15).h;mr=p['rhrFlow_kg_s']
 def mismatch(Q):
  hot=W(P=r['primaryPressure_MPa'],h=hin-Q*1000/r['primaryFlow_kg_s']);cold=W(P=.5,h=ci+Q*1000/mr)
  if hot.region!=1 or cold.region!=1:raise ValueError('Caloric cross-check left liquid region')
  return hot.T-cold.T-Q*(1/b['hotConductance_MW_K']+1/b['coldConductance_MW_K'])
 qi=brentq(mismatch,0.,q*1.25)
 ti=W(P=r['primaryPressure_MPa'],h=hin-qi*1000/r['primaryFlow_kg_s']).T-273.15
 caloric=dict(duty_MW=qi,primaryOutlet_C=ti,outletDifference_K=ti-f['primaryOutlet_C'])
 cases=[]
 for loss,restoration in [('sw',300.),('ccw',10.),('ccw',None)]:
  L=matrix(f,loss);x=initial.copy();records=[];maxBalance=0.;maxIndependent=0.;maxEventDifference=0.;maxSplitDifference=0.;ended=None
  intervals=[(0.,restoration,L),(restoration,1200.,base)] if restoration else [(0.,300.,L)]
  for start,stop,active in intervals:
   if start is None or stop is None:raise ValueError('Invalid interval')
   origin=x.copy();duration=stop-start
   exact=lambda dt:expm(active*dt)@origin
   # Detect first envelope crossing also during recovery, not just at an interval endpoint.
   def limit(time,y):return max(y[3:7])-90.
   limit.terminal=True;limit.direction=1
   independent=solve_ivp(lambda time,y:active@y,(0.,duration),origin,method='Radau',rtol=1e-10,atol=1e-9,dense_output=True,events=limit)
   if not independent.success:raise ValueError(independent.message)
   if independent.t_events[0].size:
    observed=float(independent.t_events[0][0]);left=max(0.,observed-.001);right=min(duration,observed+.001)
    duration=brentq(lambda dt:max(exact(dt)[3:7])-90,left,right);maxEventDifference=max(maxEventDifference,abs(duration-observed))
    ended='Support-liquid 90 C investigation boundary';stop=start+duration
   for dt in sorted(set([0.,min(1.,duration),min(10.,duration),duration/2,duration])):
    y=exact(dt);res=float(C@(y[:9]-initial[:9])-y[9]);maxBalance=max(maxBalance,abs(res));maxIndependent=max(maxIndependent,float(max(abs(y[:9]-independent.sol(dt)[:9]))))
    records.append(dict(time_s=start+dt,temperatures_C=dict(zip(names,map(float,y[:9]))),primaryRemoved_MW=r['primaryFlow_kg_s']*ch*(f['hotInlet_C']-y[1]),rhrPrimaryWall_MW=b['hotConductance_MW_K']*(y[1]-y[2]),rhrToCcw_MW=b['coldConductance_MW_K']*(y[2]-y[3]),boundaryEnergy_MJ=float(y[9]),energyResidual_MJ=res))
   x=exact(duration);split=expm(active*(duration/2))@(expm(active*(duration/2))@origin)
   maxSplitDifference=max(maxSplitDifference,float(max(abs(split-x))))
   if ended:break
  cases.append(dict(loss=loss,restoreAt_s=restoration,terminated=ended,finalTime_s=records[-1]['time_s'],maxEnergyResidual_MJ=maxBalance,maxIndependentTemperatureDifference_K=maxIndependent,maxEnvelopeEventDifference_s=maxEventDifference,maxSplitContinuationDifference=maxSplitDifference,records=records))
 rows.append(dict(case=f['name'],initialTemperatures_C=dict(zip(names,map(float,initial[:9]))),initialDerivativeMax_K_s=float(steady),caloric=caloric,responses=cases))
checks=dict(steady=max(v['initialDerivativeMax_K_s'] for v in rows)<1e-10,caloric=max(abs(v['caloric']['outletDifference_K']) for v in rows)<.1,
 energy=max(c['maxEnergyResidual_MJ'] for v in rows for c in v['responses'])<1e-5,independent=max(c['maxIndependentTemperatureDifference_K'] for v in rows for c in v['responses'])<1e-6,
 eventAgreement=max(c['maxEnvelopeEventDifference_s'] for v in rows for c in v['responses'])<1e-6,
 splitContinuation=max(c['maxSplitContinuationDifference'] for v in rows for c in v['responses'])<1e-7,
 circulationLossReachesLimit=all(v['responses'][2]['terminated'] is not None for v in rows))
print(json.dumps(dict(capacities_MJ_K=dict(zip(names,map(float,C))),dependencies=dict(scipy=scipy.__version__,iapws=iapws.__version__,numpy=np.__version__),checks={k:bool(v) for k,v in checks.items()},rows=rows),allow_nan=False))
`

export async function runRhrSupport(owner: string, supportOwner: string, stationOwner: string, cycleOwner: string, python: string) {
  const b = parseRhrSupport(await Bun.file(owner).text()), support = await runSupport(supportOwner, stationOwner, cycleOwner, python)
  const sb = parseSupportBasis(await Bun.file(supportOwner).text()), station = parseStationBasis(await Bun.file(stationOwner).text())
  const materials = await pythonJson(python, properties, b) as { duty_MW: number; cpHot_MJ_kgK: number; rhoHot: number }
  const cp = station.waterCp_J_kgK / 1e6, hotG = materials.duty_MW / (b.primaryOutlet_C - b.referenceWall_C)
  const coldG = materials.duty_MW / (b.referenceWall_C - b.referenceColdInlet_C - materials.duty_MW / (b.referenceColdFlow_kg_s * cp))
  if (!(coldG > 0)) throw Error('RHR reference cold side cannot meet selected wall')
  const pump = pumpDuty(b.primaryPumpTotal_kg_s, b.primaryPumpHead_MPa, materials.rhoHot, b.primaryHydraulicEfficiency, b.primaryMotorEfficiency, b.primaryDragFraction)
  const frames = (['A', 'B'] as const).flatMap(train => [20, 35].map(site => {
    const normal = train === 'A' ? support.cases.normalA.point : support.cases.normalB.point
    const branches = normal.branches.map(({ id, heat_MW, reference_kg_s, conductance_MW_K }) => ({ id, heat_MW, reference_kg_s, conductance_MW_K }))
    const sw = train === 'A' ? support.stationWithResolvedBranches.pumps.SWA : support.stationWithResolvedBranches.pumps.SWB
    const swTotal = train === 'A' ? station.SW.flowA_kg_s : station.SW.flowB_kg_s
    const swRise = sw.fluid_MW / (swTotal * cp), hp = b.primaryFlow_kg_s * materials.cpHot_MJ_kgK
    const pointAt = (Q: number) => selectSupportPoint({ ...sb, rhrLoad_MW: Q }, station, branches, site, swRise, true).point
    const mismatch = (Q: number) => {
      const p = pointAt(Q), hot = b.primaryInlet_C + (pump.fluid_MW - Q) / hp, wall = hot - Q / hotG
      return wall - p.rhrOutlet_C! - Q / coldG
    }
    let lo = 1e-10, hi = materials.duty_MW * 1.5
    if (!(mismatch(lo) > 0 && mismatch(hi) < 0)) throw Error('Coupled RHR duty not bracketed')
    for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if (mismatch(mid) > 0) lo = mid; else hi = mid }
    const Q = (lo + hi) / 2, p = pointAt(Q), hot = b.primaryInlet_C + (pump.fluid_MW - Q) / hp
    return { name: `${train}-site-${site}`, hotInlet_C: b.primaryInlet_C, site_C: site, auxiliaryHeat_MW: branches.reduce((a, v) => a + v.heat_MW, 0),
      swFluidHeat_MW: sw.fluid_MW * sb.serviceExchangerFlow_kg_s / swTotal, heat_MW: Q, primaryOutlet_C: hot, wall_C: hot - Q / hotG, point: p, thermalResidual_K: mismatch(Q) }
  }))
  const payload = { basis: b, station, materials, primaryPump: pump, hotConductance_MW_K: hotG, coldConductance_MW_K: coldG,
    swFlow_kg_s: sb.serviceExchangerFlow_kg_s, supportConductance_MW_K: sb.exchangerSide_MW_K, frames }
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')
  return { scope: 'Coupled steady sizing and finite constant-capacity heat-path response at held achieved flows/alignment; maintained primary boundary, not whole-plant cooldown or transient EOS qualification',
    inputHash: hash(JSON.stringify(payload)), sourceHash: hash(await Bun.file(import.meta.path).text()), supportSourceHash: support.sourceHash,
    stationSourceHash: support.stationSourceHash, cycleCalculationHash: support.cycleCalculationHash, cycleInputHash: support.cycleInputHash,
    ...payload, response: await pythonJson(python, response, payload), liveModelInstalled: false }
}
if (import.meta.main) {
  const [owner, support, station, cycle, python, ...extra] = Bun.argv.slice(2)
  if (!owner || !support || !station || !cycle || !python || extra.length) throw Error('Usage: reference-design-rhr-support.ts rhr.md support.md station.md cycle.md python')
  console.log(JSON.stringify(await runRhrSupport(owner, support, station, cycle, python), null, 2))
}

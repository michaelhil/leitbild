/** Offline LD-01 native inventory and finite-resource checks, not a plant initializer or trajectory.
 * Coordinates are the reviewed fixtures at the named wiki owners, not runtime defaults.
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const finite = z.number().finite()
export const parseSecondaryPreparationParent = (value: unknown, cycleInputHash: string) => {
  const parsed=z.object({referenceCycle:z.object({inputSha256:z.literal(cycleInputHash)}),support:z.object({A:z.object({point:z.object({
    head_MPa:finite.positive(),commonDrop_MPa:finite.nonnegative(),
    temperatures_C:z.object({return:finite,coolerOutlet:finite}),
    branches:z.array(z.object({id:z.enum(['RCP.A1','RCP.B1','FW.P1','COND.P','CHARGE.P']),outlet_C:finite})).length(5),
  })})})}).parse(value)
  if(new Set(parsed.support.A.point.branches.map(b=>b.id)).size!==5)throw new Error('Prepared jacket identities must occur exactly once')
  if(parsed.support.A.point.commonDrop_MPa>=parsed.support.A.point.head_MPa)throw new Error('Prepared common drop must leave positive jacket head')
  return parsed
}
const calculation = String.raw`
import sys,json,platform
import CoolProp
import scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
b=json.load(sys.stdin); c=b['cycle']; s=b['station']; checks=[]; stores=[]
def check(name,ok):
 if not ok: raise ValueError(name)
 checks.append(name)
def state(name,V,p=None,T=None,h=None,Vl=None):
 if Vl is not None:
  if p is None:p=P('P','T',T,'Q',0,'Water')
  rl=P('D','P',p,'Q',0,'Water');rv=P('D','P',p,'Q',1,'Water')
  M=rl*Vl+rv*(V-Vl);U=rl*Vl*P('U','P',p,'Q',0,'Water')+rv*(V-Vl)*P('U','P',p,'Q',1,'Water')
 else:
  coord='T' if T is not None else 'H'; val=T if T is not None else h
  rho=P('D','P',p,coord,val,'Water');M=V*rho;U=M*P('U','P',p,coord,val,'Water')
 t=P('T','D',M/V,'U',U/M,'Water');pr=P('P','D',M/V,'U',U/M,'Water')
 check(name+' native recovery',abs(pr-p)<max(1.,p*1e-7) and M>0 and U>0)
 out=dict(name=name,V_m3=V,M_kg=M,U_J=U,p_Pa=pr,T_K=t);stores.append(out);return out
for name,V,p,key in [('MS.HEADER',120,5.98e6,'main_steam'),('HP admission',10,5.96e6,'main_steam'),('HP extraction',20,4e6,'HP_bleed'),('LP first',500,.2e6,'LP_bleed'),('LP second',1000,.05e6,'LP_lowest_bleed')]:
 state(name,V,p,h=c['points'][key]['h_kJ_kg']*1000)
state('SEP',100,.8e6,Vl=10);state('RH process',30,.8e6,T=533.15);state('RH shell',20,.995*5.98e6,Vl=5)
for i,(V,p,T) in enumerate(zip([20,25,30,40],[.05e6,.2e6,.8e6,4e6],[70,110,155,220])):
 state('H'+str(i+1)+' shell',V,.995*p,Vl=.25*V)
 state('H'+str(i+1)+' tubes',10,7.35e6-i*.05e6,T=T+273.15)
fw=state('FW.TANK water',120,101325,T=313.15)
cond=state('COND',6000,T=313.15,Vl=1000)
m0=c['flows']['SG_total_kg_s'];ps=P('P','T',313.15,'Q',0,'Water');rho=P('D','T',313.15,'Q',0,'Water')
fluid=m0*(101325-ps)/rho/.8;omega=1500*2*3.141592653589793/60
pump=dict(m0_kg_s=m0,dp0_Pa=101325-ps,fluid_W=fluid,J_kg_m2=fluid*2/omega**2,initialK_J=fluid,NPSHa_m=5,NPSHr_m=3)
check('prepared condensate suction margin',pump['NPSHa_m']>pump['NPSHr_m'])
# Isolated finite-shell energy addition: no mass transfer, wall exchange or external pressure support.
def condenserE(T):
 d=cond['M_kg']/6000;q=P('Q','T',T,'D',d,'Water')
 if not 0<=q<=1:raise ValueError('Condenser caloric fixture left its two-phase interval')
 Ml=cond['M_kg']*(1-q);Vl=Ml/P('D','T',T,'Q',0,'Water');PE=9.80665*Ml*(-5+Vl/400)
 return cond['M_kg']*P('U','T',T,'D',d,'Water')+PE,PE
heat=1e10;E0,PE0=condenserE(cond['T_K']);T1=brentq(lambda T:condenserE(T)[0]-E0-heat,cond['T_K'],cond['T_K']+10);E1,PE1=condenserE(T1)
p1=P('P','T',T1,'D',cond['M_kg']/6000,'Water')
check('finite condenser warms and loses vacuum',T1>cond['T_K'] and p1>cond['p_Pa'])
check('finite condenser total energy recovery',abs(E1-E0-heat)<100)
withdrawal=fw['M_kg']/m0
check('no-return feed is finite and shorter than assessment',0<withdrawal<1800)
# CCW.A inventory uses its actual prepared nonuniform thermal coordinates plus all named jackets.
q=s['support']['A']['point'];head=q['head_MPa']*1e6;common=q['commonDrop_MPa']*1e6
parts=[('supply',250,30,0),('return',200,q['temperatures_C']['return'],common),('cooler',50,q['temperatures_C']['coolerOutlet'],0),('expansion liquid',5,30,0)]
for j in q['branches']:
 V={'RCP.A1':5,'RCP.B1':5,'FW.P1':1,'COND.P':1,'CHARGE.P':1}[j['id']]
 parts.append((j['id']+' jacket',V,j['outlet_C'],(head+common)/2))
cells=[]
for name,V,t,offset in parts:
 v=state('CCW.A '+name,V,5e5+offset,T=t+273.15);cells.append((v,offset))
totalV=sum(v['V_m3'] for v,_ in cells)+5;gamma=1+287/718
def gasV(p):return totalV-sum(v['M_kg']/P('D','P',p+dp,'T',v['T_K']+5,'Water') for v,dp in cells)
def residual(p):
 V=gasV(p)
 if V<=0:raise ValueError('Prescribed CCW fixture has no positive air volume')
 return p-5e5*(5/V)**gamma
p2=brentq(residual,5e5,5e6);V2=gasV(p2)
airM=5e5*5/(287*303.15);airT=303.15*(5/V2)**(gamma-1)
gasDeltaU=airM*718*(airT-303.15)
check('finite CCW expansion compresses retained air',p2>5e5 and 0<V2<5)
check('CCW native volume closure',abs(sum(v['M_kg']/P('D','P',p2+dp,'T',v['T_K']+5,'Water') for v,dp in cells)+V2-totalV)<1e-8)
check('adiabatic air work retained',gasDeltaU>0 and abs(p2*V2-airM*287*airT)<1e-6)
print(json.dumps(dict(scope='prepared native stores and isolated finite-resource comparisons; not coupled startup',dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),stores=stores,condensatePump=pump,noReturnFeedInventorySeconds=withdrawal,condenserHeatPulse=dict(added_J=heat,p_initial_Pa=cond['p_Pa'],p_final_Pa=p1,T_final_K=T1,liquidPE_initial_J=PE0,liquidPE_final_J=PE1,energyResidual_J=E1-E0-heat),ccwAUniformFiveKIntervention=dict(p_final_Pa=p2,airVolume_final_m3=V2,airT_final_K=airT,airCompressionEnergy_J=gasDeltaU,meaning='prescribed five-kelvin rise of every retained CCW.A liquid cell; adiabatically compressed finite air; held pressure offsets; not powered-loop trajectory or a complete loop energy balance'),checks=checks),allow_nan=False))
`

export const runSecondaryPreparation = async (wiki: string, python: string, stationReceipt: string) => {
  const ownerPaths = ['systems/steam-power/cycle-basis.md','systems/steam-power/turbine-and-regeneration-dynamics.md','systems/steam-power/condenser-and-cooling.md','systems/feedwater/index.md','systems/support-services/thermal-water-and-air.md']
  const paths = [import.meta.path,resolve(stationReceipt),...ownerPaths.map(p=>resolve(wiki,p)),resolve(import.meta.dir,'reference-design-cycle.ts')]
  const before = await Promise.all(paths.map(async path=>({path,text:await Bun.file(path).text()})))
  const cycle = await runCycle(before[2]!.text,python)
  const station = parseSecondaryPreparationParent(JSON.parse(before[1]!.text),cycle.inputSha256)
  const child=Bun.spawn([python,'-c',calculation],{stdin:new TextEncoder().encode(JSON.stringify({cycle,station})),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(stderr)
  for(const f of before)if(await Bun.file(f.path).text()!==f.text)throw new Error(`Consumed source changed: ${f.path}`)
  return {liveModelInstalled:false,sourceSha256:digest(before[0]!.text),calculationSha256:digest(calculation),sources:before.map(f=>({path:f.path,sha256:digest(f.text)})),...JSON.parse(stdout)}
}
if(import.meta.main){const [wiki,python,station]=Bun.argv.slice(2);if(!wiki||!python||!station)throw new Error('Usage: secondary-preparation <LD-01 directory> <research python> <fixed-hardware station receipt>');console.log(JSON.stringify(await runSecondaryPreparation(wiki,python,station),null,2))}

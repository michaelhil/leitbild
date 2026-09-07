/** Offline, selected LD-01 primary and regenerative-cycle design calculation.
 * This solves a particular engineering candidate, not an arbitrary plant graph.
 * Source text is fixed here; Markdown supplies validated numeric data only.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const p = z.number().finite().positive()
const efficiency = p.max(1)
const schema = z.object({
  design: z.literal('LD-01'), reactorHeat_MW: p, steamGenerators: z.literal(2),
  coreInletPressure_MPaAbs: p, coreMidPressure_MPaAbs: p, coreOutletPressure_MPaAbs: p,
  coreInlet_C: p, coreMid_C: p, coreOutlet_C: p,
  RCPSuctionPressure_MPaAbs: p, RCPDischargePressure_MPaAbs: p,
  RCPHydraulicEfficiency: efficiency, RCPMotorEfficiency: efficiency,
  RCPDragFraction: z.number().finite().nonnegative(),
  steamPressure_MPaAbs: p, feedInlet_C: p,
  feedPumpDischarge_MPaAbs: p, feedHeaderPressure_MPaAbs: p,
  feedSourcePressure_MPaAbs: p, feedPumpHydraulicEfficiency: efficiency,
  feedPumpMotorEfficiency: efficiency, feedPumpDragFraction: z.number().finite().nonnegative(),
  condensate_C: p, condensatePumpHydraulicEfficiency: efficiency,
  condensatePumpMotorEfficiency: efficiency,
  highBleedPressure_MPaAbs: p, separatorPressure_MPaAbs: p,
  lowBleedPressure_MPaAbs: p, lowestBleedPressure_MPaAbs: p,
  heaterOutlet_C: z.tuple([p,p,p]), reheatOutlet_C: p,
  HPTurbineEfficiency: efficiency, LPTurbineEfficiency: efficiency,
  shaftMechanicalEfficiency: efficiency, generatorEfficiency: efficiency,
}).strict().superRefine((b, ctx) => {
  const descending = (v: number[]) => v.every((x,i) => i===0 || v[i-1]! > x)
  for (const [ok,message] of [
    [descending([b.steamPressure_MPaAbs,b.highBleedPressure_MPaAbs,b.separatorPressure_MPaAbs,b.lowBleedPressure_MPaAbs,b.lowestBleedPressure_MPaAbs]), 'steam-path pressures must decrease'],
    [descending([b.coreOutlet_C,b.coreMid_C,b.coreInlet_C]), 'core temperatures must increase with flow'],
    [descending([b.feedInlet_C,...[...b.heaterOutlet_C].reverse(),b.condensate_C]), 'feed heating temperatures must increase'],
    [descending([b.RCPDischargePressure_MPaAbs,b.coreInletPressure_MPaAbs,b.coreMidPressure_MPaAbs,b.coreOutletPressure_MPaAbs,b.RCPSuctionPressure_MPaAbs]), 'primary pressure profile inconsistent'],
    [descending([b.feedPumpDischarge_MPaAbs,b.feedHeaderPressure_MPaAbs,b.steamPressure_MPaAbs]), 'feed pressure head insufficient'],
  ] as const) if(!ok) ctx.addIssue({code:'custom',message})
})

export const parseCycleBasis = (document: string) => {
  const blocks = [...document.matchAll(/^```reference-cycle\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1) throw new Error('Expected exactly one reference-cycle JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

const calculation = String.raw`
import sys,json,platform
import numpy as np
import scipy
from scipy.optimize import brentq
import iapws
from iapws import IAPWS97 as W
b=json.load(sys.stdin)
checks=[]
def check(name,a,e,rel=1e-8,absolute=1e-12):
    if abs(a-e)>max(absolute,abs(e)*rel):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(check=name,actual=float(a),expected=float(e),error=float(abs(a-e))))
for p,t,h in [(3,300,115.331273),(80,300,184.142828),(3,500,975.542239),(.0035,300,2549.91145),(.0035,700,3335.68375),(30,700,2631.49474)]:
    check('IF97 reference enthalpy',W(P=p,T=t).h,h)
ci=W(P=b['coreInletPressure_MPaAbs'],T=b['coreInlet_C']+273.15)
cm=W(P=b['coreMidPressure_MPaAbs'],T=b['coreMid_C']+273.15)
co=W(P=b['coreOutletPressure_MPaAbs'],T=b['coreOutlet_C']+273.15)
if any(w.region!=1 for w in [ci,cm,co]):raise ValueError('Primary reference must be compressed liquid')
mp=b['reactorHeat_MW']*1000/(co.h-ci.h)
def pumped(h,pin,pout,eta):
    a=W(P=pin,h=h); out=W(P=pout,s=a.s)
    # P,h inversion of a saturated liquid can return ~1e-16 quality.
    # This roundoff tolerance is not a two-phase pump operating allowance.
    if pout<=pin or a.x>1e-10 or out.x>1e-10:raise ValueError('Selected pump requires liquid and increasing pressure')
    result=h+(out.h-h)/eta
    if W(P=pout,h=result).x!=0:raise ValueError('Selected pump outlet must remain liquid')
    return result
def primary_pump_h(t):
    s=W(P=b['RCPSuctionPressure_MPaAbs'],T=t)
    return pumped(s.h,s.P,b['RCPDischargePressure_MPaAbs'],b['RCPHydraulicEfficiency'])
t_suction=brentq(lambda t:primary_pump_h(t)-ci.h,b['coreInlet_C']+273.15-30,b['coreInlet_C']+273.15)
suction=W(P=b['RCPSuctionPressure_MPaAbs'],T=t_suction)
primary_fluid_MW=mp*(ci.h-suction.h)/1000
primary_electric_MW=primary_fluid_MW*(1+b['RCPDragFraction'])/b['RCPMotorEfficiency']
SG_MW=b['reactorHeat_MW']+primary_fluid_MW
steam=W(P=b['steamPressure_MPaAbs'],x=1); fs=W(P=steam.P,x=0)
feed=W(P=steam.P,T=b['feedInlet_C']+273.15)
m=SG_MW*1000/(steam.h-feed.h)
cond=W(T=b['condensate_C']+273.15,x=0)
if b['lowestBleedPressure_MPaAbs']<=cond.P:raise ValueError('Final turbine interval must expand to the condenser')
if feed.x!=0:raise ValueError('Selected feed inlet must be liquid')
hc=pumped(cond.h,cond.P,b['feedSourcePressure_MPaAbs'],b['condensatePumpHydraulicEfficiency'])
hfwp=pumped(hc,b['feedSourcePressure_MPaAbs'],b['feedPumpDischarge_MPaAbs'],b['feedPumpHydraulicEfficiency'])
def expand(a,p,eta):
    if p>=a.P:raise ValueError('Turbine interval requires decreasing pressure')
    return W(P=p,h=a.h-eta*(a.h-W(P=p,s=a.s).h))
hp1=expand(steam,b['highBleedPressure_MPaAbs'],b['HPTurbineEfficiency']); dh=W(P=hp1.P,x=0)
hp2=expand(hp1,b['separatorPressure_MPaAbs'],b['HPTurbineEfficiency']); dm=W(P=hp2.P,x=0); gm=W(P=hp2.P,x=1)
rh=W(P=hp2.P,T=b['reheatOutlet_C']+273.15)
if rh.x!=1:raise ValueError('LP admission must be vapor after reheat')
lp1=expand(rh,b['lowBleedPressure_MPaAbs'],b['LPTurbineEfficiency']); dl=W(P=lp1.P,x=0)
lp2=expand(lp1,b['lowestBleedPressure_MPaAbs'],b['LPTurbineEfficiency']); dlowest=W(P=lp2.P,x=0)
lp3=expand(lp2,cond.P,b['LPTurbineEfficiency'])
if not 0<hp2.x<1:raise ValueError('Chosen HP separator requires a two-phase inlet')
heater_states=[W(P=b['feedHeaderPressure_MPaAbs'],T=t+273.15) for t in b['heaterOutlet_C']]
if any(w.x!=0 for w in heater_states):raise ValueError('Selected closed feed heaters require liquid feed')
heats=[hfwp]+[w.h for w in heater_states]+[feed.h]
if min(np.diff(heats))<=0:raise ValueError('Each selected heater must add heat')
q0,q1,q2,q3=np.diff(heats)
for hot,cold in [(dlowest.T,b['heaterOutlet_C'][0]+273.15),(dl.T,b['heaterOutlet_C'][1]+273.15),(dm.T,b['heaterOutlet_C'][2]+273.15),(dh.T,b['feedInlet_C']+273.15),(steam.T,rh.T)]:
    if hot<=cold:raise ValueError('Heating source lacks positive terminal approach')
# Unknowns normalized by total SG steam: reheat supply, four heater extractions.
# Closed-heater drains cascade to the next lower pressure and finally condenser.
def residual(v):
    r,eH,eM,eL,e0=v; hp=1-r-eH; sep=hp*(1-hp2.x); lp=hp*hp2.x-eM
    return np.array([
      r*(steam.h-fs.h)-lp*(rh.h-gm.h),
      eH*(hp1.h-dh.h)+r*(fs.h-dh.h)-q3,
      eM*(gm.h-dm.h)+(eH+r)*(dh.h-dm.h)-q2,
      eL*(lp1.h-dl.h)+(eH+r+eM+sep)*(dm.h-dl.h)-q1,
      e0*(lp2.h-dlowest.h)+(eH+r+eM+sep+eL)*(dl.h-dlowest.h)-q0])
zero=residual(np.zeros(5));matrix=np.column_stack([residual(np.eye(5)[i])-zero for i in range(5)])
v=np.linalg.solve(matrix,-zero);r,eH,eM,eL,e0=v
hp=1-r-eH;sep=hp*(1-hp2.x);lp=hp*hp2.x-eM;finalLP=lp-eL-e0
drains=r+eH+eM+sep+eL+e0
if min(*v,hp,lp,finalLP,sep,drains)<=0:raise ValueError('Selected cycle has nonpositive material flow')
work=(1-r)*(steam.h-hp1.h)+hp*(hp1.h-hp2.h)+lp*(rh.h-lp1.h)+(lp-eL)*(lp1.h-lp2.h)+finalLP*(lp2.h-lp3.h)
condenser=finalLP*lp3.h+drains*dlowest.h-cond.h
pump_fluid=(hfwp-cond.h)
fw_fluid=hfwp-hc;cp_fluid=hc-cond.h
fw_elec=m*fw_fluid/1000*(1+b['feedPumpDragFraction'])/b['feedPumpMotorEfficiency']
cp_elec=m*cp_fluid/1000/b['condensatePumpMotorEfficiency']
thermo_work_MW=m*work/1000
gross=thermo_work_MW*b['shaftMechanicalEfficiency']*b['generatorEfficiency']
for i,x in enumerate(residual(v)):check('heater/reheater balance '+str(i),x,0,absolute=1e-9)
check('condenser mass',finalLP+drains,1,rel=1e-12)
check('closed secondary first law kJ/kg',steam.h-feed.h+pump_fluid,work+condenser,rel=1e-10)
check('core heat kW',mp*(co.h-ci.h),b['reactorHeat_MW']*1000,rel=1e-12)
check('primary loop heat MW',mp*(co.h-suction.h)/1000,SG_MW,rel=1e-12)
check('feed heater aggregate kJ/kg',sum(np.diff(heats)),feed.h-hfwp,rel=1e-12)
points={}
for name,w in [('core_inlet',ci),('core_mid',cm),('core_outlet',co),('RCP_suction',suction),('main_steam',steam),('HP_bleed',hp1),('HP_separator_inlet',hp2),('LP_reheat_inlet',rh),('LP_bleed',lp1),('LP_lowest_bleed',lp2),('LP_exhaust',lp3),('condenser_liquid',cond)]:
    points[name]=dict(p_MPaAbs=w.P,T_C=w.T-273.15,h_kJ_kg=w.h,rho_kg_m3=w.rho)
out=dict(dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__),
 points=points,
 flows=dict(primary_kg_s=float(mp),RCP_each_kg_s=float(mp/4),SG_total_kg_s=float(m),SG_each_kg_s=float(m/2),
 reheat_fraction=float(r),high_heater_fraction=float(eH),separator_heater_fraction=float(eM),low_heater_fraction=float(eL),lowest_heater_fraction=float(e0),separator_drain_fraction=float(sep),LP_inlet_fraction=float(lp),LP_exhaust_fraction=float(finalLP),condenser_drains_fraction=float(drains)),
 powers_MW=dict(core=b['reactorHeat_MW'],RCP_fluid=float(primary_fluid_MW),RCP_electric=float(primary_electric_MW),SG_total=float(SG_MW),
 core_cell1=float(mp*(cm.h-ci.h)/1000),core_cell2=float(mp*(co.h-cm.h)/1000),
 turbine_thermodynamic_work=float(thermo_work_MW),gross_electric=float(gross),condenser=float(m*condenser/1000),
 feed_pump_fluid=float(m*fw_fluid/1000),feed_pump_electric=float(fw_elec),condensate_pump_fluid=float(m*cp_fluid/1000),condensate_pump_electric=float(cp_elec),
 electrical_after_listed_pumps=float(gross-primary_electric_MW-fw_elec-cp_elec),
 regenerated_feed_heat=float(m*(feed.h-hfwp)/1000)),
 quality=dict(HP_separator_inlet=hp2.x,LP_exhaust=lp3.x),checks=checks)
print(json.dumps(out,allow_nan=False))
`

export const runCycle = async (document: string, python: string) => {
  const basis = parseCycleBasis(document), input = JSON.stringify(basis)
  const child = Bun.spawn([python,'-c',calculation],{stdin:new TextEncoder().encode(input),stdout:'pipe',stderr:'pipe'})
  const [output,error,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code!==0)throw new Error(`Reference cycle calculation failed: ${error}`)
  return {inputSha256:createHash('sha256').update(input).digest('hex'),calculationSha256:createHash('sha256').update(calculation).digest('hex'),basis,...JSON.parse(output)}
}
if(import.meta.main){
  const [file,python]=Bun.argv.slice(2)
  if(!file||!python)throw new Error('Usage: bun reference-design-cycle.ts <cycle-basis.md> <isolated-python>')
  console.log(JSON.stringify(await runCycle(await Bun.file(file).text(),python),null,2))
}

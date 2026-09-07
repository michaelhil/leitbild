/** Fixed-temperature two-loop/four-RCP pressure-network study; not dynamic initialization. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle.ts'

const finite=z.number().finite(),positive=finite.positive()
const schema=z.object({design:z.literal('LD-01'),gravity_m_s2:positive,
  coreInlet_m:finite,coreMid_m:finite,coreOutlet_m:finite,hotPort_m:finite,SGturn_m:finite,coldPort_m:finite,
  SGInlet_MPaAbs:positive,coldReturn_MPaAbs:positive,pumpRpm:positive,pumpShapeFraction:positive.max(.9),
}).strict().superRefine((b,c)=>{
  if(!(b.coreInlet_m<b.coreMid_m&&b.coreMid_m<b.coreOutlet_m&&b.coreOutlet_m<b.hotPort_m&&b.hotPort_m<b.SGturn_m&&b.coldPort_m<b.SGturn_m))
    c.addIssue({code:'custom',message:'Selected vertical path ordering is inconsistent'})
})
export const parseHydraulicBasis=(document:string)=>{
  const blocks=[...document.matchAll(/^```reference-hydraulics\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-hydraulics block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const calculation=String.raw`
import sys,json,math
import numpy as np
from scipy.optimize import root
d=json.load(sys.stdin); b=d['basis']; c=d['cycle']; s=c['points']; p=c['powers_MW']; g=b['gravity_m_s2']
M0=c['flows']['primary_kg_s']; m0=M0/4; ml0=M0/2
ci=s['core_inlet']; cm=s['core_mid']; co=s['core_outlet']; suction=s['RCP_suction']; rho=suction['rho_kg_m3']
def Pa(v):return v*1e6
H={
 'cold_to_core':ci['rho_kg_m3']*g*(b['coreInlet_m']-b['coldPort_m']),
 'core_lower':(ci['rho_kg_m3']+cm['rho_kg_m3'])/2*g*(b['coreMid_m']-b['coreInlet_m']),
 'core_upper':(cm['rho_kg_m3']+co['rho_kg_m3'])/2*g*(b['coreOutlet_m']-b['coreMid_m']),
 'hot':co['rho_kg_m3']*g*(b['hotPort_m']-b['coreOutlet_m']),
 'SG':g*(co['rho_kg_m3']*(b['SGturn_m']-b['hotPort_m'])+rho*(b['coldPort_m']-b['SGturn_m']))}
F={
 'cold_to_core':Pa(b['coldReturn_MPaAbs']-ci['p_MPaAbs'])-H['cold_to_core'],
 'core_lower':Pa(ci['p_MPaAbs']-cm['p_MPaAbs'])-H['core_lower'],
 'core_upper':Pa(cm['p_MPaAbs']-co['p_MPaAbs'])-H['core_upper'],
 'hot':Pa(co['p_MPaAbs']-b['SGInlet_MPaAbs'])-H['hot'],
 'SG':Pa(b['SGInlet_MPaAbs']-suction['p_MPaAbs'])-H['SG'],
 'pump_outlet':Pa(c['basis']['RCPDischargePressure_MPaAbs']-b['coldReturn_MPaAbs'])}
if min(F.values())<=0:raise ValueError('Target ports require nonpositive passive resistance; revise geometry/pressure basis')
K={k:v/(M0 if k in ('cold_to_core','core_lower','core_upper') else m0 if k=='pump_outlet' else ml0)**2 for k,v in F.items()}
q0=m0/rho; omega0=b['pumpRpm']*2*math.pi/60; e0=p['RCP_fluid']*1e6/M0; sigma=b['pumpShapeFraction']
a=e0/((1-sigma)*omega0**2); beta=sigma*a*omega0/q0
dp0=Pa(c['basis']['RCPDischargePressure_MPaAbs']-suction['p_MPaAbs'])
R=(rho*e0-dp0)/(rho*q0*q0)
if R<=0:raise ValueError('RCP selected point cannot provide dissipative passage')
common=sum(K[k] for k in ('cold_to_core','core_lower','core_upper')); loop=K['hot']+K['SG']; hydro=sum(H.values())
def pump(m,n):
 q=m/rho; w=n*omega0
 return rho*w*(a*w-beta*q)-R*rho*q*abs(q)
def loss(k,m):return K[k]*m*abs(m)
def solve(name,speeds,guess):
 def residual(x):
  flows=x*m0; total=sum(flows); loops=[flows[0]+flows[1],flows[2]+flows[3]]
  return np.array([(pump(m,speeds[i])-loss('pump_outlet',m)-loop*loops[i//2]*abs(loops[i//2])-common*total*abs(total)-hydro)/dp0 for i,m in enumerate(flows)])
 r=root(residual,np.array(guess),tol=1e-11)
 error=float(max(abs(residual(r.x)))*dp0)
 if not r.success or error>1e-5:raise ValueError(f'{name}: hydraulic solve failed: {r.message}; residual {error}Pa')
 flows=r.x*m0; total=sum(flows); loops=[sum(flows[:2]),sum(flows[2:])]
 # One absolute datum at the core inlet; all other pressures follow solved losses.
 core_in=Pa(ci['p_MPaAbs']); cold=core_in+H['cold_to_core']+loss('cold_to_core',total)
 mid=core_in-H['core_lower']-loss('core_lower',total)
 out=mid-H['core_upper']-loss('core_upper',total)
 ports=[]
 for j,flow in enumerate(loops):
  hot=out-H['hot']-loss('hot',flow); sg=hot-H['SG']-loss('SG',flow)
  discharge=[cold+loss('pump_outlet',flows[2*j+i]) for i in range(2)]
  ports.append(dict(SG_inlet_MPa=hot/1e6,SG_outlet_MPa=sg/1e6,RCP_discharge_MPa=[v/1e6 for v in discharge]))
 return dict(name=name,speeds=speeds,pump_flows_kg_s=flows.tolist(),loop_flows_kg_s=loops,total_kg_s=float(total),
  outside_selected_pump_flow_sweep=[i for i,m in enumerate(flows) if abs(m/m0)>1.5],
  core_mid_MPa=mid/1e6,core_out_MPa=out/1e6,cold_return_MPa=cold/1e6,ports=ports,max_pressure_residual_Pa=error)
nominal=solve('all pumps at selected speed',[1,1,1,1],[1,1,1,1])
alternate=solve('same nominal from unequal initial numerical guess',[1,1,1,1],[.4,1.7,.8,1.3])
stopped=solve('A1 shaft held stopped; temperatures prescribed',[0,1,1,1],[-.2,1.2,.9,.9])
if max(abs(np.array(nominal['pump_flows_kg_s'])-m0))>1e-6:raise ValueError('Nominal flow does not reproduce calibration')
if max(abs(np.array(nominal['pump_flows_kg_s'])-np.array(alternate['pump_flows_kg_s'])))>1e-6:raise ValueError('Different guesses disagree')
if stopped['pump_flows_kg_s'][0]>=0:raise ValueError('Selected stopped parallel passage should reverse in this imposed-temperature case')
# Buoyancy head-work is a mechanical scale, not a whole-loop energy residual.
# Mass-specific g*dz cancels around a closed path; individual streams still need it.
gravityPower=M0/rho*hydro/1e6
maxLocalPE=max(abs(b['SGturn_m']-b['hotPort_m']),abs(b['coldPort_m']-b['SGturn_m']),abs(b['coreInlet_m']-b['coldPort_m']))*g
print(json.dumps(dict(hydrostatic_Pa=H,friction_Pa=F,resistance_Pa_per_kg_s_squared=K,
 net_hydrostatic_Pa=hydro,nominal_pump_head_Pa=dp0,
 gravity_head_work_scale_MW=gravityPower,gravity_head_work_fraction_core=abs(gravityPower)/p['core'],
 largest_segment_potential_difference_J_kg=maxLocalPE,
 cases=[nominal,alternate,stopped],checks={'positive_resistances':True,'nominal_reproduced':True,'independent_initial_guess':True,'stopped_passage_reversal':True}),allow_nan=False))
`
export async function runHydraulics(document:string,cycleDocument:string,python:string){
  const basis=parseHydraulicBasis(document),cycle=await runCycle(cycleDocument,python)
  const child=Bun.spawn([python,'-c',calculation],{stdin:Buffer.from(JSON.stringify({basis,cycle})),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code!==0)throw new Error(`Hydraulic reference failed: ${err}`)
  return {inputSha256:createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    calculationSha256:createHash('sha256').update(calculation).digest('hex'),cycleInputSha256:cycle.inputSha256,
    cycleCalculationSha256:cycle.calculationSha256,dependencies:cycle.dependencies,basis,...JSON.parse(out)}
}
if(import.meta.main){
  const [file,cycleFile,python]=Bun.argv.slice(2)
  if(!file||!cycleFile||!python)throw new Error('Usage: bun reference-design-hydraulics.ts <hydraulic-basis.md> <cycle-basis.md> <isolated-python>')
  console.log(JSON.stringify(await runHydraulics(await Bun.file(file).text(),await Bun.file(cycleFile).text(),python),null,2))
}

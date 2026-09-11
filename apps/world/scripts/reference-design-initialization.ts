/** Offline connected sealed-primary DAE. No production runtime or arbitrary wiki code. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle.ts'
import { runHydraulics } from './reference-design-hydraulics.ts'
import { replayHotAInstruments } from './reference-design-observations.ts'
import type { fuelGeometry } from './reference-design-fuel-construction.ts'
export type PhysicalCoreReference={geometry:ReturnType<typeof fuelGeometry>;activeLength_m:number;
  gridsPerHalf:number;blockageFraction:number;gridLossFactor:number;inletLoss:number;outletLoss:number}

const positive=z.number().finite().positive()
const schema=z.object({design:z.literal('LD-01'),
  volumes_m3:z.tuple([positive,positive,positive,positive,positive,positive,positive,positive,positive,positive,positive]),
  metalCapacity_MJ_K:positive, motorTracking_s:positive, inertiaDecay_s:positive,
  hold_s:positive, holdStep_s:positive, perturbation_s:positive, steps_s:z.tuple([positive,positive,positive]),
  sourcePulseFraction:positive.max(.01), sourcePulse_s:positive,
}).strict().superRefine((b,c)=>{
  if(Math.abs(b.volumes_m3.reduce((a,v)=>a+v,0)-220)>1e-9)c.addIssue({code:'custom',message:'The admitted main circuit must retain 220 m3'})
  if(!(b.steps_s[0]===2*b.steps_s[1]&&b.steps_s[1]===2*b.steps_s[2]))c.addIssue({code:'custom',message:'Independent time refinement requires successive halving'})
  if(!(b.sourcePulse_s<b.perturbation_s))c.addIssue({code:'custom',message:'Pulse must finish before the observation interval'})
  for(const step of [...b.steps_s,b.holdStep_s])for(const end of [b.hold_s,b.perturbation_s,b.sourcePulse_s])
    if(Math.abs(end/step-Math.round(end/step))>1e-8)c.addIssue({code:'custom',message:'Selected event/end times must lie on every step grid'})
})
export const parseInitializationBasis=(document:string)=>{
  const blocks=[...document.matchAll(/^```reference-initialization\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-initialization block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const unforcedTraceDrift=(samples:Array<{p_MPa:number[];T_C:number[]}>)=>{
  const first=samples[0]
  if(!first||samples.length<2||first.p_MPa.length!==11||first.T_C.length!==11)throw new Error('Expected a retained eleven-cell hold trace')
  let pressure_MPa=0,temperature_K=0
  for(const sample of samples){
    if(sample.p_MPa.length!==11||sample.T_C.length!==11||![...sample.p_MPa,...sample.T_C].every(Number.isFinite))throw new Error('Malformed or nonfinite hold sample')
    for(let i=0;i<11;i++){
      pressure_MPa=Math.max(pressure_MPa,Math.abs(sample.p_MPa[i]!-first.p_MPa[i]!))
      temperature_K=Math.max(temperature_K,Math.abs(sample.T_C[i]!-first.T_C[i]!))
    }
  }
  return {pressure_MPa,temperature_K,accepted:pressure_MPa<1e-5&&temperature_K<1e-4}
}

/** Shared equations for the original apparatus and the radial heat handoff.
 * The caller supplies validated numeric d; no source is read from the wiki. */
export const primaryReferencePython=String.raw`
import sys,json,math,time
import numpy as np
from scipy.optimize import root
from iapws import IAPWS97 as W
from iapws.iapws97 import _Region1
from iapws._iapws import _Viscosity
b=d['basis']; c=d['cycle']; hy=d['hydraulics']; core=d['physicalCore']; cb=c['basis']; hb=hy['basis']
g=hb['gravity_m_s2']; names=['DOWNCOMER','LOWER','CORE.1','CORE.2','UPPER','HOT.A','HOT.B','SG.A.PRIMARY','SG.B.PRIMARY','COLD.A','COLD.B']
V=np.array(b['volumes_m3']); z=np.array([3,-2,0,2,2,2.5,2.5,3,3,3,3.]); Cwall=b['metalCapacity_MJ_K']*1e6
s=c['points']; M0=c['flows']['primary_kg_s']; m0=M0/4; ml0=M0/2; Pcore=c['powers_MW']['core']*1e6
Qcore=np.array([c['powers_MW']['core_cell1'],c['powers_MW']['core_cell2']])*1e6
Pfluid0=c['powers_MW']['RCP_fluid']*1e6/4; omega0=hb['pumpRpm']*2*math.pi/60
rho0=s['RCP_suction']['rho_kg_m3']; q0=m0/rho0; e0=Pfluid0/m0; sigma=hb['pumpShapeFraction']
a=e0/((1-sigma)*omega0**2); blade=sigma*a*omega0/q0
R=(rho0*e0-600000)/(rho0*q0*q0); drag0=cb['RCPDragFraction']*Pfluid0
J=(Pfluid0+drag0)*b['inertiaDecay_s']/omega0**2; torque0=(Pfluid0+drag0)/omega0
Tsink=s['main_steam']['T_C']; Tsg0=s['RCP_suction']['T_C']; Tmetal0=(Tsink+Tsg0)/2
G=c['powers_MW']['SG_total']*1e6/2/(Tsg0-Tmetal0)
# One physical oriented edge. Zero-drop connections remain equations, never 1/K.
ends=[(0,1),(1,2),(2,3),(3,4),(4,5),(4,6),(5,7),(6,8),(7,9),(7,9),(8,10),(8,10),(9,0),(10,0)]
refs=np.array([M0,M0,M0,M0,ml0,ml0,ml0,ml0,m0,m0,m0,m0,ml0,ml0])
oldK=hy['resistance_Pa_per_kg_s_squared']
K=np.array([oldK['cold_to_core'],oldK['core_lower'],oldK['core_upper'],0,oldK['hot'],oldK['hot'],oldK['SG'],oldK['SG'],oldK['pump_outlet'],oldK['pump_outlet'],oldK['pump_outlet'],oldK['pump_outlet'],0,0])
if core:K[1:4]=0. # Replaced, not added to the former pressure-calibrated core budget.
def coreLoss(k,m,rho,T):
 if not core or k not in (1,2,3):return None
 area=core['geometry']['flowArea_m2']; dh=core['geometry']['hydraulicDiameter_m']
 G=m/area; mu=_Viscosity(rho,T+273.15); re=abs(G)*dh/mu
 if re==0:return dict(Re=0.,Darcy=0.,distributed_Pa=0.,grid_Pa=0.,local_Pa=0.,total_Pa=0.)
 f=max(64/re,1.691*re**(-.43),.117*re**(-.14))
 dynamic=G*abs(G)/(2*rho)
 kg=min(20.,196*re**(-.333))*core['gridLossFactor']*core['blockageFraction']**2
 distributed=f*core['activeLength_m']/2/dh*dynamic if k in (1,2) else 0.
 grid=core['gridsPerHalf']*kg*dynamic if k in (1,2) else 0.
 local=(core['inletLoss'] if k==1 else core['outletLoss'] if k==3 else 0.)*dynamic
 return dict(Re=re,Darcy=f,distributed_Pa=distributed,grid_Pa=grid,local_Pa=local,total_Pa=distributed+grid+local)
# Reference density belongs to the actual upstream nominal state, not a global cold density.
pseed=np.array([15.2,15.2,15.1,15.,15.,14.95,14.95,14.7,14.7,15.2,15.2])
hseed=np.array([s['core_inlet']['h_kJ_kg']]*2+[s['core_mid']['h_kJ_kg']]+[s['core_outlet']['h_kJ_kg']]*4+[s['RCP_suction']['h_kJ_kg']]*2+[s['core_inlet']['h_kJ_kg']]*2)
Tseed=np.array([W(P=p,h=h).T-273.15 for p,h in zip(pseed,hseed)])
rhoseed=np.array([1/_Region1(T+273.15,p)['v'] for p,T in zip(pseed,Tseed)])
rhoref=np.array([rhoseed[i] for i,j in ends]); xseed=np.r_[pseed/15,Tseed/300,np.ones(14),[Tmetal0/300]*2,np.ones(4)]
checks=[]; counters=dict(residualCalls=0,propertyStates=0,solverCalls=0); statuses={}
def startMeter():return (time.perf_counter(),counters.copy())
def endMeter(start):return dict(wall_s=time.perf_counter()-start[0],**{k:v-start[1][k] for k,v in counters.items()})
allStart=startMeter()
def require(name,condition,**values):
 if not condition:raise ValueError(name+': '+str(values))
 checks.append(dict(check=name,**values))
propertyBand=dict(p_MPa=(14.,16.5),T_C=(275.,328.))
def properties(p,T):
 # Explicit narrow liquid investigation band; never allow Region1 extrapolation into boiling.
 if not np.all(np.isfinite(p)) or not np.all(np.isfinite(T)):raise ValueError('Nonfinite property input')
 if min(p)<propertyBand['p_MPa'][0] or max(p)>propertyBand['p_MPa'][1] or min(T)<propertyBand['T_C'][0] or max(T)>propertyBand['T_C'][1]:raise ValueError('Outside sealed-primary liquid investigation band')
 counters['propertyStates']+=len(p)
 rho=[]; h=[]; u=[]
 for pp,tt in zip(p,T):
  v=_Region1(tt+273.15,pp); rho.append(1/v['v']); h.append(v['h']*1000); u.append(v['h']*1000-pp*1e6*v['v'])
 return np.array(rho),np.array(h),np.array(u)
def evaluate(x,sourceFactor=1,A1request=1,wallHeat=None):
 if not np.all(np.isfinite(x)):raise ValueError('Nonfinite solver iterate')
 p=x[:11]*15; T=x[11:22]*300; m=x[22:36]*refs; Tw=x[36:38]*300; omega=x[38:42]*omega0
 rho,h,u=properties(p,T); mass=V*rho; energy=mass*u; dM=np.zeros(11); dU=np.zeros(11); hyd=[]
 fluid=[]; torques=[]; electrical=[]; ambient=[]; domega=[]
 for k,(i,j) in enumerate(ends):
  upstream=i if m[k]>=0 else j; ru=rho[upstream]
  if k==0:head=(rho[0]+rho[1])/2*g*(z[1]-z[0])
  elif k in (1,2):head=(rho[i]+rho[j])/2*g*(z[j]-z[i])
  elif k in (6,7):head=g*(rho[i]*(hb['SGturn_m']-z[i])+rho[j]*(z[j]-hb['SGturn_m']))
  else:head=rho[upstream]*g*(z[j]-z[i])
  pumphead=0; power=0
  if 8<=k<=11:
   n=k-8; q=m[k]/ru; w=omega[n]
   tf=ru*q*(a*w-blade*q); power=w*tf; pumphead=ru*w*(a*w-blade*q)-R*ru*q*abs(q)
   td=drag0/omega0**2*w
   requested=omega0*(A1request if n==0 else 1)
   tm=np.clip(tf+td+J*(requested-w)/b['motorTracking_s'],0,1.5*torque0)
   if w<0:raise ValueError('Reverse rotor operation outside powered-motor admission')
   pe=tm*w/cb['RCPMotorEfficiency']; loss=pe-tm*w+td*w
   fluid.append(power); torques.append(tf); electrical.append(pe); ambient.append(loss); domega.append((tm-tf-td)/J)
  selectedCore=coreLoss(k,m[k],ru,T[upstream])
  loss=selectedCore['total_Pa'] if selectedCore is not None else K[k]*m[k]*abs(m[k])*rhoref[k]/ru
  hyd.append((p[i]-p[j])*1e6+pumphead-head-loss)
  dM[i]-=m[k]; dM[j]+=m[k]; flux=m[k]*h[upstream]
  dU[i]-=flux; dU[j]+=flux
  # The massless pump deposits actual shaft work in the actual receiving cell.
  if power!=0:dU[j if m[k]>=0 else i]+=power
 heat=Qcore*sourceFactor if wallHeat is None else np.asarray(wallHeat)
 if heat.shape!=(2,) or not np.all(np.isfinite(heat)):raise ValueError('Expected two finite physical core wall heats')
 dU[2:4]+=heat
 Qp=G*(T[7:9]-Tw); Qs=G*(Tw-Tsink); dU[7:9]-=Qp
 dw=(Qp-Qs)/Cwall
 return dict(p=p,T=T,m=m,Tw=Tw,omega=omega,mass=mass,energy=energy,dM=dM,dU=dU,hyd=np.array(hyd),dw=dw,domega=np.array(domega),Qp=Qp,Qs=Qs,
  electrical=np.array(electrical),ambient=np.array(ambient),fluid=np.array(fluid),rho=rho,
  totalStored=float(sum(energy)+Cwall*sum(Tw)+.5*J*sum(omega**2)),externalPower=float(sum(heat)+sum(electrical)-sum(ambient)-sum(Qs)))
def steady(x,anchor=True):
 counters['residualCalls']+=1
 e=evaluate(x); mr=e['dM']/M0
 if anchor:mr[0]=(e['p'][1]-cb['coreInletPressure_MPaAbs'])/.6
 return np.r_[mr,e['dU']/Pcore,e['hyd']/600000,e['dw']*Cwall/Pcore,e['domega']*J/torque0]
def solve(fun,guess,label):
 counters['solverCalls']+=1
 r=root(fun,guess,tol=1e-10); values=fun(r.x); residual=float(max(abs(values)))
 if not np.all(np.isfinite(r.x)) or not np.all(np.isfinite(values)) or not math.isfinite(residual) or residual>2e-9:raise ValueError(label+': residual '+str(residual)+'; '+str(r.message))
 # Near a solved stiff state MINPACK may report stalled progress. Accept only
 # finite dimensional/scaled residual tests, not its status flag alone.
 status=str(r.status)+': '+str(r.message); statuses[status]=statuses.get(status,0)+1
 return r.x,residual
`
const calculation=String.raw`
import json,sys
d=json.load(sys.stdin)
${primaryReferencePython}
steadyStart=startMeter()
x0,res=solve(steady,xseed,'steady'); e0s=evaluate(x0)
alter=xseed.copy(); alter[:11]+=.001; alter[11:22]+=.002; alter[22:36]*=np.linspace(.9,1.1,14); alter[36:38]+=.002
xalt,ra=solve(steady,alter,'independent initial guess')
require('independent initial guesses',max(abs(xalt-x0))<1e-7,max_scaled_difference=float(max(abs(xalt-x0))))
weights=np.geomspace(.1,10,42)
xscaled,rs=solve(lambda x:weights*steady(x),alter,'different residual scaling')
require('residual scaling does not change operating point',max(abs(xscaled-x0))<1e-7,max_scaled_difference=float(max(abs(xscaled-x0))))
require('steady physical residuals',max(abs(e0s['dM']))<1e-4 and max(abs(e0s['dU']))<10 and max(abs(e0s['hyd']))<1,max_mass_kg_s=float(max(abs(e0s['dM']))),max_energy_W=float(max(abs(e0s['dU']))),max_pressure_Pa=float(max(abs(e0s['hyd']))))
def jac(fun,x):
 step=2e-6
 return np.column_stack([(fun(x+np.eye(len(x))[i]*step)-fun(x-np.eye(len(x))[i]*step))/(2*step) for i in range(len(x))])
sv=np.linalg.svd(jac(steady,x0),compute_uv=False); svfree=np.linalg.svd(jac(lambda x:steady(x,False),x0),compute_uv=False)
require('one initialization datum closes one mass null mode',sv[-1]>1e-7 and svfree[-1]<1e-7 and svfree[-2]>1e-7,anchored_smallest=float(sv[-1]),free_smallest=float(svfree[-1]),free_next=float(svfree[-2]),scaled_condition=float(sv[0]/sv[-1]))
steadyCost=endMeter(steadyStart)
# Independent public IF97 wrapper verifies the narrow direct Region1 evaluation.
for i in range(11):
 w=W(P=e0s['p'][i],T=e0s['T'][i]+273.15)
 require('solved cell compressed-liquid EOS '+names[i],w.region==1 and abs(w.rho*V[i]-e0s['mass'][i])<1e-6 and abs(w.u*1000*e0s['mass'][i]-e0s['energy'][i])<.1)
def advanceResidual(x,old,dt,factor,A1request=1):
 counters['residualCalls']+=1
 e=evaluate(x,factor,A1request)
 return np.r_[((e['mass']-old['mass'])/dt-e['dM'])/M0,((e['energy']-old['energy'])/dt-e['dU'])/Pcore,e['hyd']/600000,
  ((e['Tw']-old['Tw'])/dt-e['dw'])*Cwall/Pcore,((e['omega']-old['omega'])/dt-e['domega'])*J/torque0]
svstep=np.linalg.svd(jac(lambda x:advanceResidual(x,e0s,.05,1),x0),compute_uv=False)
require('unanchored implicit step has full numerical rank',svstep[-1]>1e-7,smallest=float(svstep[-1]),scaled_condition=float(svstep[0]/svstep[-1]))
def compact(t,e):
 return dict(t_s=t,p_MPa=e['p'].tolist(),T_C=e['T'].tolist(),flow_kg_s=e['m'].tolist(),wall_C=e['Tw'].tolist(),rpm=(e['omega']*60/(2*math.pi)).tolist(),SG_heat_MW=(e['Qs']/1e6).tolist(),stored_J=e['totalStored'])
def integrate(label,dt,end,pulse=False,shaftPerturb=False):
 runStart=startMeter()
 x=x0.copy()
 initial=evaluate(x); current=initial; mass0=sum(initial['mass']); ledger=0.; physicalLedger=0.; rotorLoss=0.; maxMass=0.; maxEnergy=0.; maxRawEnergy=0.; maxR=0.; maxStoredPEBound=0.; samples=[compact(0,current)]
 for n in range(round(end/dt)):
  t=(n+1)*dt; factor=1+b['sourcePulseFraction'] if pulse and n*dt<b['sourcePulse_s']-1e-9 else 1
  request=.999 if shaftPerturb and n*dt<b['sourcePulse_s']-1e-9 else 1
  old=current; x,r=solve(lambda y:advanceResidual(y,old,dt,factor,request),x,label+' step'+str(n)); current=evaluate(x,factor,request)
  # Backward Euler fluid/wall ledgers are exact at step endpoints. Rotor energy
  # has known numerical dissipation J/2*(delta omega)^2, reported not hidden.
  rotorNumerical=.5*J*sum((current['omega']-old['omega'])**2)
  physicalLedger+=current['externalPower']*dt; rotorLoss+=rotorNumerical; ledger=physicalLedger-rotorLoss
  maxMass=max(maxMass,abs(sum(current['mass'])-mass0)); maxEnergy=max(maxEnergy,abs(current['totalStored']-initial['totalStored']-ledger)); maxRawEnergy=max(maxRawEnergy,abs(current['totalStored']-initial['totalStored']-physicalLedger)); maxR=max(maxR,r)
  maxStoredPEBound=max(maxStoredPEBound,g*12*sum(abs(current['mass']-initial['mass'])))
  if abs(t*10-round(t*10))<1e-8 or n==round(end/dt)-1:samples.append(compact(t,current))
 require(label+' conservation',maxMass<.001 and maxEnergy<10000 and maxRawEnergy<10000,max_mass_error_kg=float(maxMass),max_energy_error_J=float(maxEnergy),max_uncorrected_energy_defect_J=float(maxRawEnergy),max_scaled_step_residual=maxR)
 return dict(name=label,step_s=dt,samples=samples,max_mass_error_kg=float(maxMass),max_energy_error_J=float(maxEnergy),max_scaled_residual=maxR,
  integratedExternalEnergy_J=float(physicalLedger),rotorNumericalDissipation_J=float(rotorLoss),maxUncorrectedEnergyDefect_J=float(maxRawEnergy),
  omittedStoredPEChangeBound_J=float(maxStoredPEBound),
  cost=endMeter(runStart),commandEvents=[dict(t_s=0,sourceFactor=1+b['sourcePulseFraction'] if pulse else 1,A1speedRequestFraction=.999 if shaftPerturb else 1),dict(t_s=b['sourcePulse_s'],sourceFactor=1,A1speedRequestFraction=1)] if pulse or shaftPerturb else [],
  finalPressureDrift_MPa=float(max(abs(current['p']-initial['p']))),finalTemperatureDrift_K=float(max(abs(current['T']-initial['T']))))
hold=integrate('unforced exact steady hold',b['holdStep_s'],b['hold_s'])
require('held-state drift',hold['finalPressureDrift_MPa']<1e-5 and hold['finalTemperatureDrift_K']<1e-4,pressure_MPa=hold['finalPressureDrift_MPa'],temperature_K=hold['finalTemperatureDrift_K'])
runs=[integrate('source pulse dt'+str(dt),dt,b['perturbation_s'],True) for dt in b['steps_s']]
shaftRuns=[integrate('A1 speed request reduced 0.1 percent dt'+str(dt),dt,b['perturbation_s'],False,True) for dt in b['steps_s']]
ref=[]
for coarse,fine in list(zip(runs[:-1],runs[1:]))+list(zip(shaftRuns[:-1],shaftRuns[1:])):
 differences={k:0. for k in ['p_MPa','T_C','flow_kg_s','wall_C','rpm']}; fs={round(s['t_s'],8):s for s in fine['samples']}
 for sample in coarse['samples']:
  if round(sample['t_s'],8) not in fs:continue
  match=fs[round(sample['t_s'],8)]
  for k in differences:differences[k]=max(differences[k],float(max(abs(np.array(sample[k])-np.array(match[k])))))
 ref.append(dict(case=coarse['name'],coarse_s=coarse['step_s'],fine_s=fine['step_s'],maxCommonTimeDifferences=differences))
for index,label in [(1,'heat pulse'),(3,'shaft request')]:
 last=ref[index]['maxCommonTimeDifferences']
 require(label+' refinement acceptance',last['p_MPa']<.001 and last['T_C']<.01 and last['flow_kg_s']<5 and last['wall_C']<.01 and last['rpm']<.1,**last)
require('unclamped pressure responds to source pulse',max(max(abs(np.array(v['p_MPa'])-e0s['p'])) for v in runs[-1]['samples'])>1e-5)
# Bound hydrostatic pressure variation ignored by one homogeneous EOS state/lump.
depths=np.array([6,2,2,2,2,0,0,9,9,0,0]); portEOSVariation=e0s['rho']*g*depths/1e6
rhoSensitivity=[max(abs(1/_Region1(e0s['T'][i]+273.15,e0s['p'][i]+sign*portEOSVariation[i])['v']/e0s['rho'][i]-1) for sign in [-1,1]) for i in range(11)]
cells=[dict(cell=names[i],volume_m3=float(V[i]),pressureDatum_m=float(z[i]),p_MPa=float(e0s['p'][i]),T_C=float(e0s['T'][i]),M_kg=float(e0s['mass'][i]),U_J=float(e0s['energy'][i]),ignoredHomogeneousHydrostaticRange_MPa=float(portEOSVariation[i]),isothermalDensitySensitivityFraction=float(rhoSensitivity[i])) for i in range(11)]
coreSensitivity=[]
if core:
 originalFactor=core['gridLossFactor']
 for factor in (0.,.5,2.):
  core['gridLossFactor']=originalFactor*factor
  trial,trialResidual=solve(steady,x0,'grid-loss sensitivity '+str(factor)); e=evaluate(trial)
  coreSensitivity.append(dict(gridFactorRelativeToSelected=factor,coreFlow_kg_s=float(e['m'][1]),
   coreOutletPressure_MPa=float(e['p'][3]),coreOutletTemperature_C=float(e['T'][3]),maxScaledResidual=trialResidual))
 core['gridLossFactor']=originalFactor
 require('grid loss changes achieved flow without pump retuning',coreSensitivity[0]['coreFlow_kg_s']>e0s['m'][1]>coreSensitivity[-1]['coreFlow_kg_s'])
 for k in (1,2,3):
  i,j=ends[k]; m=e0s['m'][k]; rho=e0s['rho'][i]; T=e0s['T'][i]
  plus=coreLoss(k,m,rho,T); minus=coreLoss(k,-m,rho,T); zero=coreLoss(k,0.,rho,T)
  require('physical core signed passive loss '+str(k),plus['total_Pa']>0 and abs(plus['total_Pa']+minus['total_Pa'])<1e-8 and zero['total_Pa']==0)
print(json.dumps(dict(boundary='sealed liquid primary; prescribed core heat, SG secondary temperatures and supported motor electrical boundary',
 physicalCore=core,nominalCoreHydraulics=[coreLoss(k,e0s['m'][k],e0s['rho'][ends[k][0]],e0s['T'][ends[k][0]]) for k in (1,2,3)] if core else None,
 coreSensitivity=coreSensitivity,
 coreHeat_W=Qcore.tolist(),
 cells=cells,edges=[dict(upstream=names[i],downstream=names[j],K=float(K[k]),flow_kg_s=float(e0s['m'][k])) for k,(i,j) in enumerate(ends)],
 nominal=compact(0,e0s),primaryMass_kg=float(sum(e0s['mass'])),SGConductance_W_K=float(G),rotorInertia_kg_m2=float(J),
 nominalElectrical_MW=(e0s['electrical']/1e6).tolist(),nominalAmbient_MW=(e0s['ambient']/1e6).tolist(),nominalFluid_MW=(e0s['fluid']/1e6).tolist(),
 initialPressureAnchor_MPa=cb['coreInletPressure_MPaAbs'],hold=hold,pulseRuns=runs,shaftRuns=shaftRuns,refinement=ref,checks=checks,
 energyApproximation=dict(convention='fluid internal energy plus wall and rotor; h-only material flux; no fluid kinetic or gravitational storage/transport',
  absoluteStoredPEBound_J=float(sum(e0s['mass'])*g*12),largestLocalTransportPE_J_kg=float(g*max(5,9.5,9)),
  largestNominalLocalPEFlux_W=float(max(M0*g*5,ml0*g*9.5)),kineticEnergyBound='Not closed: local flow areas/velocities outside the core were not selected; do not claim total mechanical energy accuracy'),
 cost=dict(initializationIncludingRankAndScaling=steadyCost,total=endMeter(allStart),solverStatuses=statuses,propertyCountScope='11 narrow Region1 states per evaluator call; calibration/full-wrapper comparisons excluded')),allow_nan=False))
`

export async function resolveInitializationInput(document:string,hydraulicDocument:string,cycleDocument:string,python:string,physicalCore:PhysicalCoreReference|null=null){
  const basis=parseInitializationBasis(document)
  if(physicalCore){
    basis.volumes_m3[2]=physicalCore.geometry.coreFlowVolume_m3/2
    basis.volumes_m3[3]=physicalCore.geometry.coreFlowVolume_m3/2
  }
  const [cycle,hydraulics]=await Promise.all([runCycle(cycleDocument,python),runHydraulics(hydraulicDocument,cycleDocument,python)])
  return {basis,cycle,hydraulics,physicalCore}
}
export async function runInitialization(document:string,hydraulicDocument:string,cycleDocument:string,python:string,physicalCore:PhysicalCoreReference|null=null){
  const data=await resolveInitializationInput(document,hydraulicDocument,cycleDocument,python,physicalCore)
  const {basis,cycle,hydraulics}=data
  const child=Bun.spawn([python,'-c',calculation],{stdin:Buffer.from(JSON.stringify(data)),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code!==0)throw new Error(`Connected initialization failed: ${err}`)
  const result=JSON.parse(out),traceDrift=unforcedTraceDrift(result.hold.samples)
  if(!traceDrift.accepted)throw new Error('Intermediate unforced hold drift exceeds the declared criterion')
  const hotAReplay=replayHotAInstruments(result.pulseRuns[2].samples)
  const interruptedHotAReplay=replayHotAInstruments(result.pulseRuns[2].samples,[.5,2])
  const measuredP=hotAReplay.rows.map(r=>r.pressure!.value),measuredT=hotAReplay.rows.map(r=>r.temperature!.value)
  const physicalT=result.pulseRuns[2].samples.map((r:{T_C:number[]})=>r.T_C[5]!)
  const observationChecks={pressureHasResolvedChange:Math.max(...measuredP)-Math.min(...measuredP)>=.001,
    roundedTemperatureUnchanged:new Set(measuredT).size===1,physicalTemperatureChanged:Math.max(...physicalT)-Math.min(...physicalT)>1e-4,
    noCurrentValueDuringPowerLoss:interruptedHotAReplay.rows.filter(r=>!r.I1Powered).every(r=>r.pressure===null&&r.temperature===null),
    restorationRequiresAcquisition:interruptedHotAReplay.rows.find(r=>Math.abs(r.t_s-2)<1e-8)?.reason==='REACQUIRING'}
  if(!Object.values(observationChecks).every(Boolean))throw new Error('Actual-trace instrument replay criterion failed')
  return {inputSha256:createHash('sha256').update(JSON.stringify(basis)).digest('hex'),calculationSha256:createHash('sha256').update(calculation).digest('hex'),
    physicalCoreInputSha256:createHash('sha256').update(JSON.stringify(physicalCore)).digest('hex'),
    traceAcceptanceSha256:createHash('sha256').update(unforcedTraceDrift.toString()).digest('hex'),
    observationReplaySha256:createHash('sha256').update(replayHotAInstruments.toString()).digest('hex'),
    cycleInputSha256:cycle.inputSha256,cycleCalculationSha256:cycle.calculationSha256,hydraulicInputSha256:hydraulics.inputSha256,hydraulicCalculationSha256:hydraulics.calculationSha256,dependencies:cycle.dependencies,basis,...result,traceDrift,hotAReplay,interruptedHotAReplay,observationChecks}
}
if(import.meta.main){
  const [file,hydraulicFile,cycleFile,python]=Bun.argv.slice(2)
  if(!file||!hydraulicFile||!cycleFile||!python)throw new Error('Usage: bun reference-design-initialization.ts <initialization.md> <hydraulic-basis.md> <cycle-basis.md> <isolated-python>')
  console.log(JSON.stringify(await runInitialization(await Bun.file(file).text(),await Bun.file(hydraulicFile).text(),await Bun.file(cycleFile).text(),python),null,2))
}

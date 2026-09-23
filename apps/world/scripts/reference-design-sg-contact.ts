/** Bounded secondary contact-law screen. Not a coupled SG or secondary-cycle solver. */
import {createHash} from 'node:crypto'
import {poolBoilingPython} from './reference-design-pool-boiling'
import {nativePoolContactPython} from './reference-design-native-pool-contact'

export const sgContactBasis={area_m2:5000,diameter_m:.02,metalCapacity_J_K:150e6,length_m:20,freeArea_m2:7.5,bottom_m:2.5,gasSensible_W_m2K:5,effectiveEmissivity:.3,steelConductivity_W_mK:15,steelDensity_kg_m3:8000,steelCp_J_kgK:500,pressure_Pa:6e6,nominalWall_C:282.675682,oldSizingSecondary_C:275.586411,sizingDuty_W:1508.377509e6}
export const sgContactPython=String.raw`
import sys,json,math,functools
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
from scipy.integrate import solve_ivp
d=json.load(sys.stdin);geo=d;g=9.80665;sb=5.670374419e-8;b={'surfaceFactor':1.}
${poolBoilingPython}
${nativePoolContactPython}
checks=[]
def check(name,value,expected,tolerance):
 if not math.isfinite(value) or abs(value-expected)>tolerance:raise ValueError((name,value,expected,tolerance))
 checks.append(dict(name=name,value=value,expected=expected,tolerance=tolerance))
D=d['diameter_m'];A=d['area_m2'];eps=d['effectiveEmissivity']
def case(name,p,T,Tw):
 q,regime=contacted(p,T,Tw,D,epsilon=eps)
 if not math.isfinite(q) or q*(Tw-T)<0:raise ValueError('Heat violates temperature direction')
 return dict(name=name,pressure_Pa=p,liquid_K=T,wall_K=Tw,heatFlux_W_m2=q,wholeWetDuty_W=A*q,regime=regime)
p=d['pressure_Pa'];Ts=sat(p)['T'];Tw=d['nominalWall_C']+273.15
nominal=case('unchanged sizing wall with native saturated pure-water secondary',p,Ts,Tw)
nominal.update(sizingDuty_W=d['sizingDuty_W'],dutyRatio=nominal['wholeWetDuty_W']/d['sizingDuty_W'],difference_W=nominal['wholeWetDuty_W']-d['sizingDuty_W'],nativeMinusOldSecondary_K=Ts-(d['oldSizingSecondary_C']+273.15),naturalFilm_W_m2K=liquid_h(p,Ts,Tw,D),onset_K=wet_state(p,Ts,Tw,D)[1])
endpointRows=[];cases=[]
for pressure in [1e5,1e6,6e6]:
 for T in [sat(pressure)['T'],313.15]:
  tc,tm,qc,qm=endpoints(pressure,T,D,epsilon=eps)
  endpointRows.append(dict(pressure_Pa=pressure,liquid_K=T,TCHF_K=tc,Tmin_K=tm,qCHF_W_m2=qc,qmin_W_m2=qm,ordered=True))
  cases.extend([case('equal temperature',pressure,T,T),case('reverse liquid contact',pressure,T,T-5),case('retained 300C wall recontact',pressure,T,573.15),case('hot film wall recontact',pressure,T,923.15)])
  check('equal liquid heat',cases[-4]['heatFlux_W_m2'],0,1e-12)
  for transition in [tc,tm]:
   left=contacted(pressure,T,transition-1e-5,D,epsilon=eps)[0]
   right=contacted(pressure,T,transition+1e-5,D,epsilon=eps)[0]
   check('continuous selected thermal endpoint relative difference',(right-left)/qc,0,1e-4)
tc,tm,qc,qm=endpoints(p,Ts,D,epsilon=eps)
nominal['CHF_fraction']=nominal['heatFlux_W_m2']/qc
nominal['wallForSizingDuty_K']=brentq(lambda wall:contacted(p,Ts,wall,D,epsilon=eps)[0]-d['sizingDuty_W']/A,Ts,tc)
nominal['wallForSizingDutyMeaning']='Held-pressure constitutive comparison, not a connected stationary solve or retuned coefficient'
R=1.5/(math.pi-2);Lu=9.5-R;Ld=9-R;zc=12-R
def wet_length(Vl):
 if not 0<=Vl<=120:raise ValueError('Secondary volume outside actual finite envelope')
 H=d['bottom_m']+Vl/d['freeArea_m2']
 arc=0 if H<=zc else math.pi*R if H>=12 else 2*R*math.asin((H-zc)/R)
 return min(Lu,max(0,H-2.5))+min(Ld,max(0,H-3))+arc
geometry=[]
for Vl,f in [(0,0),(40,.5083333333333333),(71.25,1),(72,1)]:
 actual=wet_length(Vl)/d['length_m'];check('folded wet length fraction',actual,f,1e-12)
 geometry.append(dict(liquidVolume_m3=Vl,surface_m=d['bottom_m']+Vl/d['freeArea_m2'],wetLength_m=wet_length(Vl),fraction=actual))
check('folded developed length',Lu+Ld+math.pi*R,20,1e-12)
check('secondary effective volume',d['freeArea_m2']*(18.5-d['bottom_m']),120,1e-12)
# This is local storage-incidence arithmetic, NOT a time-integrated refill history.
wall=[550+20*(j+.5)/20 for j in range(20)];capacity=d['metalCapacity_J_K']/20
E=sum(capacity*T for T in wall)
memory=[]
for Vl in [72,40,0,.75,72]:
 memory.append(dict(liquidVolume_m3=Vl,wetLength_m=wet_length(Vl),retainedWallEnergy_J=E))
 check('contact change does not change retained wall energy',sum(capacity*T for T in wall),E,1e-6)
gas=[]
for factor in [.5,1,2]:
 for delta in [-200,0,200]:
  gas.append(dict(coefficientFactor=factor,wallMinusGas_K=delta,fullDryDuty_W=A*d['gasSensible_W_m2K']*factor*delta))
# Fixed-area finite isochoric laboratory contact: initial inventory corresponds
# to 1% SG wet length, but contact is held, NOT recomputed as an SG level history.
sp=sat(1e5);V=120.;Vl=1.5;Ml=Vl*sp['rl'];Mv=(V-Vl)*sp['rv'];M=Ml+Mv;U0=Ml*sp['ul']+Mv*sp['uv']
area=.01*A;Twall0=573.15;totalC=d['metalCapacity_J_K'];coupons=[]
def native(U):
 T=P('T','D',M/V,'U',U/M,'Water');p=P('P','D',M/V,'U',U/M,'Water');quality=P('Q','D',M/V,'U',U/M,'Water')
 if not 0<=quality<=1:raise ValueError('Fixed wet-contact coupon exits its liquid-bearing two-phase domain')
 return dict(T=T,p=p,quality=quality,liquidMass=M*(1-quality),liquidVolume=M*(1-quality)/sat(p)['rl'])
for fraction in [.01,1.]:
 C=totalC*fraction;heldC=totalC-C;series=[]
 for rtol,maxstep in [(1e-7,.5),(1e-9,.25)]:
  def rate(time,y):
   state=native(U0+y[0]);Tw=Twall0-y[0]/C
   return [area*contacted(state['p'],state['T'],Tw,D,epsilon=eps)[0]]
  def depleted(time,y):return native(U0+y[0])['liquidMass']
  depleted.terminal=True;depleted.direction=-1
  sol=solve_ivp(rate,[0,20],[0.],method='Radau',rtol=rtol,atol=.01,max_step=maxstep,dense_output=True,events=depleted)
  if not sol.success:raise ValueError(sol.message)
  states=[]
  for time in [0,1,5,10,float(sol.t[-1])]:
   x=float(sol.sol(time)[0]);water=native(U0+x);Tw=Twall0-x/C
   # Independent native U readback plus active and untouched wall energy.
   Ur=M*P('U','P',water['p'],'Q',water['quality'],'Water')
   ledger=Ur+C*Tw+heldC*Twall0-(U0+totalC*Twall0)
   check('finite coupon native total energy',ledger,0,1)
   states.append(dict(time_s=time,transferredEnergy_J=x,wall_K=Tw,untouchedWall_K=Twall0,**water,totalEnergyResidual_J=ledger))
  series.append(dict(rtol=rtol,maxStep_s=maxstep,states=states,solverEvaluations=sol.nfev))
 a=series[0]['states'][-1];bcheck=series[1]['states'][-1]
 check('coupon accuracy wall temperature',a['wall_K'],bcheck['wall_K'],.001)
 check('coupon accuracy water temperature',a['T'],bcheck['T'],.001)
 check('coupon accuracy transferred energy',a['transferredEnergy_J'],bcheck['transferredEnergy_J'],10)
 coupons.append(dict(activeMetalFraction=fraction,activeCapacity_J_K=C,untouchedCapacity_J_K=heldC,fixedWetArea_m2=area,waterVolume_m3=V,waterMass_kg=M,initialWaterEnergy_J=U0,results=series))
print(json.dumps(dict(scope='Pure-water source-law/geometry selection and fixed-contact finite isochoric coupon; no actual moving SG coverage/refill trajectory, NC boiling law, primary coastdown, acquired LT or installed cooling qualification',basis=d,nominal=nominal,endpoints=endpointRows,cases=cases,geometry=geometry,wallMemoryArithmetic=memory,dryGasSensible=gas,finiteContactCoupons=coupons,checks=checks,versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),sort_keys=True,allow_nan=False))
`

if(import.meta.main){
 const [python,output,...rest]=process.argv.slice(2)
 if(!python||!output||rest.length)throw Error('Usage: sg-contact <research-python> <output.json>')
 const names=['reference-design-pool-boiling.ts','reference-design-native-pool-contact.ts']
 const source=await Bun.file(import.meta.path).text(),dependencies=Object.fromEntries(await Promise.all(names.map(async n=>[n,await Bun.file(new URL(n,import.meta.url)).text()])))
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const proc=Bun.spawn([python,'-c',sgContactPython],{stdin:new Blob([JSON.stringify(sgContactBasis)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited])
 if(code)throw Error(err)
 if(await Bun.file(import.meta.path).text()!==source)throw Error('Source changed during calculation')
 for(const name of names)if(await Bun.file(new URL(name,import.meta.url)).text()!==dependencies[name])throw Error('Dependency changed during calculation')
 const result={sourceSha256:hash(source),calculationSha256:hash(sgContactPython),inputSha256:hash(JSON.stringify(sgContactBasis)),dependencies:Object.fromEntries(names.map(n=>[n,hash(dependencies[n]!)])),...JSON.parse(out)}
 await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({output,nominal:result.nominal,endpoints:result.endpoints,checks:result.checks.length}))
}

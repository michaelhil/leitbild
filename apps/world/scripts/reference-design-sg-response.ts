/** Offline finite-secondary response and distribution-memory sensitivity.
 * Deliberately frozen clean-water fixture; not parsed current plant configuration.
 * Internal U and datum-zero prescribed enthalpy ports omit PE/KE. Not a full
 * apparatus/primary/wall ledger, installed controller or physical calibration.
 */
import { createHash } from 'node:crypto'

export const sgResponseBasis = {
  volume_m3: 120, liquidVolume_m3: 72, pressure_Pa: 6e6, levelArea_m2: 12,
  nominalHeat_W: 1508.377509e6, feedTemperature_K: 493.15,
  nominalSubmergedVolume_m3: 12, maximumSubmergedVolume_m3: 24,
  distributionTime_s: 2, duration_s: 40, perturbationEnd_s: 10,
}

export const sgResponseCalculation = String.raw`
import sys,json,math
import numpy as np
import scipy,CoolProp
from scipy.integrate import solve_ivp
import CoolProp.CoolProp as CP
d=json.load(sys.stdin);V=d['volume_m3'];A=d['levelArea_m2']
l=CP.AbstractState('HEOS','Water');g=CP.AbstractState('HEOS','Water')
feed=CP.AbstractState('HEOS','Water')
def props(p):
 l.update(CP.PQ_INPUTS,float(p),0);g.update(CP.PQ_INPUTS,float(p),1)
 return np.array([l.rhomass(),g.rhomass(),l.umass(),g.umass(),l.hmass(),g.hmass()])
def stores(M,p):
 rl,rg,ul,ug,hl,hg=props(p);Vl=(M-rg*V)/(rl-rg);Vg=V-Vl
 if not 0<Vl<V:raise ValueError('Finite comparison left its two-phase domain')
 return dict(U=rl*Vl*ul+rg*Vg*ug,Mv=rg*Vg,Vl=Vl,Vg=Vg,rg=rg,hg=hg)
p0=d['pressure_Pa'];pr=props(p0);M0=pr[0]*d['liquidVolume_m3']+pr[1]*(V-d['liquidVolume_m3'])
s0=stores(M0,p0);feed.update(CP.PT_INPUTS,p0,d['feedTemperature_K']);hf=feed.hmass()
F=d['nominalHeat_W']/(s0['hg']-hf);residence=d['nominalSubmergedVolume_m3']*s0['rg']/F
cases={'steam demand rise':(1,1.2,1,1),'feed deficit':(.8,1,1,1),
       'heat input decrease':(1,1,.7,1),'colder feed':(1,1,1,.8)}
records=[];checks=[]
def check(name,value,limit):
 checks.append(dict(name=name,value=float(value),limit=limit))
 if not math.isfinite(value) or abs(value)>limit:raise ValueError(checks[-1])
for name,forcing in cases.items():
 family=[]
 for factor in [.5,1,2]:
  for stages in [1,8]:
   series=[]
   for refined in [False,True]:
    tau=d['distributionTime_s']*factor
    # Memory states distribute a common target through an Erlang kernel.
    # They do not create additional water/gas inventories or heat stores.
    y0=np.r_[0.,0.,0.,0.,np.full(stages,d['nominalSubmergedVolume_m3']*factor/s0['Vg'])]
    def evaluate(y,active):
     M=M0+y[0];p=p0+y[1];s=stores(M,p);base=props(p)
     # Native EOS saturation derivatives, not a difference of large U stores.
     rlp=l.first_saturation_deriv(CP.iDmass,CP.iP);rgp=g.first_saturation_deriv(CP.iDmass,CP.iP)
     ulp=l.first_saturation_deriv(CP.iUmass,CP.iP);ugp=g.first_saturation_deriv(CP.iUmass,CP.iP)
     Vlp=(-rgp*V-s['Vl']*(rlp-rgp))/(base[0]-base[1])
     Mvp=rgp*s['Vg']-base[1]*Vlp
     Up=(base[3]-base[2])*Mvp+base[0]*s['Vl']*ulp+base[1]*s['Vg']*ugp
     UM=(base[0]*base[2]-base[1]*base[3])/(base[0]-base[1]);MvM=-base[1]/(base[0]-base[1])
     fm,sm,qm,hm=forcing if active else (1,1,1,1)
     fi=F*fm;so=F*sm;mass=fi-so;energy=d['nominalHeat_W']*qm+fi*hf*hm-so*s['hg']
     pdot=(energy-UM*mass)/Up;mvdot=Mvp*pdot+MvM*mass
     evap=max(0.,mvdot+so);target=min(s['Vg'],d['maximumSubmergedVolume_m3'],residence*factor*evap/s['rg'])/s['Vg']
     memory=y[4:];memory_rate=stages/tau*(np.r_[target,memory[:-1]]-memory)
     return np.r_[mass,pdot,energy,so,memory_rate]
    histories=[];y=y0
    for begin,end,active in [(0,d['perturbationEnd_s'],True),(d['perturbationEnd_s'],d['duration_s'],False)]:
     sol=solve_ivp(lambda t,y:evaluate(y,active),(begin,end),y,method='DOP853',
        rtol=1e-11 if refined else 1e-9,atol=np.r_[1e-9,.0001,.0001,1e-9,np.full(stages,1e-11)],
        max_step=.1 if refined else .2,dense_output=True)
     if not sol.success:raise ValueError(sol.message)
     times=np.linspace(begin,end,round((end-begin)*10)+1)
     for t in times[1:] if begin else times:
      x=sol.sol(t);s=stores(M0+x[0],p0+x[1]);beta=float(x[-1])
      if not 0<=beta<=1:raise ValueError('Distribution left physical interval')
      energy=s['U']-s0['U']-x[2]
      histories.append(dict(t=float(t),p=float(p0+x[1]),massChange=float(x[0]),
        collapsed=s['Vl']/A,apparent=(s['Vl']+beta*s['Vg'])/A,energyError=float(energy)))
     y=sol.y[:,-1]
    check(name+' native energy J',max(abs(x['energyError']) for x in histories),10.)
    series.append(histories)
   coarse,fine=series
   check(name+' pressure refinement Pa',max(abs(a['p']-b['p']) for a,b in zip(coarse,fine)),1.)
   check(name+' apparent-level refinement m',max(abs(a['apparent']-b['apparent']) for a,b in zip(coarse,fine)),1e-5)
   initial=fine[0];during=[x for x in fine if 0<x['t']<=10]
   family.append(dict(factor=factor,stages=stages,nominalResidence_s=residence*factor,
     distributionMean_s=tau,initialApparent_m=initial['apparent'],
     pressureExcursion_Pa=[min(x['p']-p0 for x in during),max(x['p']-p0 for x in during)],
     apparentExcursion_m=[min(x['apparent']-initial['apparent'] for x in during),max(x['apparent']-initial['apparent'] for x in during)],
     collapsedExcursion_m=[min(x['collapsed']-initial['collapsed'] for x in during),max(x['collapsed']-initial['collapsed'] for x in during)],
     atOneSecond=next(x for x in fine if abs(x['t']-1)<1e-9),atTenSeconds=during[-1],
     final=fine[-1],maximumEnergyDefect_J=max(abs(x['energyError']) for x in fine)))
  records.append(dict(case=name,selectedBoundaries=dict(feedFactor=forcing[0],steamFactor=forcing[1],heatFactor=forcing[2],feedEnthalpyFactor=forcing[3]),results=family)) if factor==2 else None
# A separate native-M/U integration uses EOS inversion and Radau, rather than
# the candidate's pressure-coordinate derivative and DOP853 integration.
coordinate_comparisons=[]
flash=CP.AbstractState('HEOS','Water')
for record in records:
 forcing=cases[record['case']];y=np.zeros(2);points={}
 def native_pressure(y):
  mass=M0+y[0];energy=s0['U']+y[1]
  flash.update(CP.DmassUmass_INPUTS,mass/V,energy/mass)
  if not 0<flash.Q()<1:raise ValueError('Independent native state left two-phase domain')
  return flash.p()
 for begin,end,active in [(0,d['perturbationEnd_s'],True),(d['perturbationEnd_s'],d['duration_s'],False)]:
  def rhs(t,y):
   p=native_pressure(y);hg=props(p)[5];fm,sm,qm,hm=forcing if active else (1,1,1,1)
   return [F*(fm-sm),d['nominalHeat_W']*qm+F*fm*hf*hm-F*sm*hg]
  sol=solve_ivp(rhs,(begin,end),y,method='Radau',rtol=1e-10,atol=[1e-9,.001],max_step=.1,dense_output=True)
  if not sol.success:raise ValueError(sol.message)
  for t in [1.,10.,40.]:
   if begin<t<=end:points[t]=native_pressure(sol.sol(t))
  y=sol.y[:,-1]
 selected=next(x for x in record['results'] if x['factor']==1 and x['stages']==1)
 expected=[selected['atOneSecond']['p'],selected['atTenSeconds']['p'],selected['final']['p']]
 error=max(abs(points[t]-p) for t,p in zip([1.,10.,40.],expected))
 check(record['case']+' independent native-coordinate pressure Pa',error,1.)
 coordinate_comparisons.append(dict(case=record['case'],maximumPressureDifference_Pa=error))
print(json.dumps(dict(basis=d,initialMass_kg=M0,initialEnergy_J=s0['U'],nominalSteam_kg_s=F,
 nominalResidence_s=residence,records=records,checks=checks,independentNativeCoordinateComparisons=coordinate_comparisons,
 scope='Frozen clean two-phase internal-U fixture with prescribed datum-zero enthalpy/heat histories; no PE/KE, primary/wall/SGTR ownership. Memory chains add no material storage. Not a coupled SG/contact/controller qualification or external calibration.',
 versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

if (import.meta.main) {
  const [python, output] = Bun.argv.slice(2)
  if (!python || !output) throw Error('Usage: reference-design-sg-response.ts python output.json')
  if (await Bun.file(output).exists()) throw Error('Refusing to overwrite retained receipt')
  const child = Bun.spawn([python, '-c', sgResponseCalculation], {
    stdin: new Blob([JSON.stringify(sgResponseBasis)]), stdout: 'pipe', stderr: 'inherit',
  })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('SG response comparison rejected')
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = { sourceHash: sha(await Bun.file(import.meta.path).text()),
    calculationHash: sha(sgResponseCalculation), ...JSON.parse(out) }
  await Bun.write(output, JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify({ output, sourceHash: result.sourceHash, checks: result.checks.length }))
}

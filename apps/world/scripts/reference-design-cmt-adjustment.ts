/** Offline finite-parcel convective adjustment; no transient admission or entrainment law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive=z.number().finite().positive()
const schema=z.object({area_m2:positive,volume_m3:positive,topElevation_m:z.number().finite(),
  initialTopPressure_MPa:positive.min(1).max(20),volumeResidual_m3:positive,
  energyResidual_J:positive,entropyTolerance_J_K:positive,
  quadraturePressureDifference_Pa:positive,unmergedWorkResidual_J:positive}).strict()
export function parseAdjustmentBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-adjustment\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-adjustment numeric block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Aperture membership only; never a guessed distribution of actual orifice flow. */
export function apertureMembership(centers:number[],diameter:number,interfaceElevation:number) {
  if(!centers.length||![...centers,diameter,interfaceElevation].every(Number.isFinite)||diameter<=0)
    throw new Error('Invalid aperture geometry')
  return centers.map(z=>z-diameter/2>=interfaceElevation?'upper':
    z+diameter/2<=interfaceElevation?'lower':'straddles')
}

export const adjustmentCalculation=String.raw`
import json,sys,math,time
import numpy as np
from scipy.optimize import root,brentq
from numpy.polynomial.legendre import leggauss
from iapws.iapws97 import _Region1,_Backward1_T_Ps,_TSat_P
b=json.load(sys.stdin);g=9.80665;A=b['area_m2'];zt=b['topElevation_m'];V=b['volume_m3']

def water_ps(p,s):
    if not 1e5<p<30e6:raise ValueError('Pressure outside admitted liquid reference')
    T=_Backward1_T_Ps(p/1e6,s/1000)
    for _ in range(5):
        if not 273.15<T<623.15:raise ValueError('Temperature outside region1')
        r=_Region1(T,p/1e6);error=r['s']*1000-s
        if abs(error)<1e-8:break
        T-=error*T/(r['cp']*1000)
    if not math.isfinite(T) or not 273.15<T<623.15:raise ValueError('Final temperature outside region1')
    r=_Region1(T,p/1e6);error=r['s']*1000-s
    if not math.isfinite(error) or abs(error)>1e-7 or (p<22.064e6 and T>=_TSat_P(p/1e6)):
        raise ValueError('Entropy inversion outside liquid region1')
    return r['v'],r['h']*1000-p*r['v'],T

def column(p,masses,entropies,n=8,properties=water_ps):
    if len(masses)!=len(entropies) or not len(masses) or any(m<=0 for m in masses):raise ValueError('Invalid finite parcels')
    nodes,weights=leggauss(n);aboveM=0.;aboveV=0.;rows=[]
    for mass,s in zip(masses,entropies):
        m=aboveM+(nodes+1)*mass/2;w=weights*mass/2
        values=np.array([properties(p+g*x/A,s) for x in m]);v,u,T=values.T
        vol=float(w@v);internal=float(w@u)
        # Fubini integral computes the real distributed PE, not a midpoint centroid.
        pe=g*mass*(zt-aboveV/A)-g/A*float(w@((aboveM+mass-m)*v))
        rows.append(dict(mass_kg=float(mass),entropy_J_kgK=float(s),volume_m3=vol,energy_J=internal+pe,
            topElevation_m=zt-aboveV/A,bottomElevation_m=zt-(aboveV+vol)/A,
            topPressure_Pa=p+g*aboveM/A,bottomPressure_Pa=p+g*(aboveM+mass)/A,
            meanTemperature_K=float(w@T/mass)))
        aboveM+=mass;aboveV+=vol
    return dict(topPressure_Pa=float(p),mass_kg=float(sum(masses)),volume_m3=aboveV,
        energy_J=sum(r['energy_J'] for r in rows),entropy_J_K=float(np.dot(masses,entropies)),parcels=rows)

def initial(temperatures,fractions,n=8):
    p=b['initialTopPressure_MPa']*1e6
    # Temperatures define s at one declared reference pressure, not uniform-T parcels.
    ss=np.array([_Region1(t+273.15,p/1e6)['s']*1000 for t in temperatures])
    ff=np.array(fractions,dtype=float)
    mass=brentq(lambda m:column(p,ff*m,ss,n)['volume_m3']-V,V*600,V*1100,xtol=1e-8)
    mm=ff*mass
    return mm,ss,column(p,mm,ss,n)

def solve_adjustment(masses,ss,old,block,fraction=1.,n=8):
    # A fixed finite reference. No local volume/pressure reset and no parcel deletion.
    def result(x):
        new=ss.copy();new[block]=ss[block]*(1-fraction)+x[1]*1000*fraction
        return new,column(x[0]*1e7,masses,new,n)
    def residual(x):
        new,state=result(x)
        return [(state['volume_m3']-old['volume_m3'])/V,(state['energy_J']-old['energy_J'])/1e10]
    guess=[old['topPressure_Pa']/1e7,float(np.dot(masses[block],ss[block])/sum(masses[block]))/1000]
    sol=root(residual,guess,method='hybr',options=dict(xtol=1e-10))
    if not np.all(np.isfinite(sol.x)):raise ValueError('Nonfinite global adjustment')
    new,state=result(sol.x)
    dv=state['volume_m3']-old['volume_m3'];de=state['energy_J']-old['energy_J'];ds=state['entropy_J_K']-old['entropy_J_K']
    if not all(math.isfinite(v) for v in [dv,de,ds]) or abs(dv)>b['volumeResidual_m3'] or abs(de)>b['energyResidual_J'] or ds < -b['entropyTolerance_J_K']:
        raise ValueError('Global adjustment ledger/entropy rejection: '+str((dv,de,ds)))
    return new,state,dict(volumeResidual_m3=dv,energyResidual_J=de,entropyChange_J_K=ds)

def continuation(masses,ss,old,block,steps):
    previous=old;works=np.zeros(len(masses));sumInterfaceCancellation=0.;minimumDS=float('inf')
    for k in range(1,steps+1):
        _,current,_=solve_adjustment(masses,ss,old,block,k/steps)
        increments=[]
        for a,c in zip(previous['parcels'],current['parcels']):
            # Mechanical work from BOTH moving boundaries; internal forces cancel.
            work=A*((a['bottomPressure_Pa']+c['bottomPressure_Pa'])/2*(c['bottomElevation_m']-a['bottomElevation_m'])-
                    (a['topPressure_Pa']+c['topPressure_Pa'])/2*(c['topElevation_m']-a['topElevation_m']))
            increments.append(work)
        works+=increments;sumInterfaceCancellation=max(sumInterfaceCancellation,abs(sum(increments)))
        minimumDS=min(minimumDS,current['entropy_J_K']-previous['entropy_J_K']);previous=current
    unmixed=[i for i in range(len(masses)) if i not in block]
    defects=[previous['parcels'][i]['energy_J']-old['parcels'][i]['energy_J']-works[i] for i in unmixed]
    return dict(steps=steps,unmergedIndices=unmixed,unmergedEnergyMinusBoundaryWork_J=defects,
        maximumUnmergedWorkResidual_J=max([abs(v) for v in defects],default=0.),
        maximumNetBoundaryWork_J=sumInterfaceCancellation,minimumEntropyIncrement_J_K=minimumDS,
        perParcelBoundaryWork_J=works.tolist())

def independent_checks():
    # Constant v/u exact identity exercises actual mass-coordinate quadrature and PE.
    mass=np.array([1000.,2000.,3000.]);s=np.array([100.,90.,80.]);v=.001;u=100000.;p=15e6
    c=column(p,mass,s,properties=lambda p,s:(v,u,300.))
    exact=sum(mass)*u+g*sum(mass)*(zt-sum(mass)*v/(2*A))
    if abs(c['energy_J']-exact)>1e-5:raise ValueError('Mass-coordinate PE identity failed')
    mm,ss,a=initial([100.,100.,100.,100.],[.01,.01,.01,.97])
    _,same,res=solve_adjustment(mm,ss,a,np.array([0,1,2,3]))
    if abs(same['topPressure_Pa']-a['topPressure_Pa'])>1 or abs(res['entropyChange_J_K'])>.01:
        raise ValueError('Uniform-entropy identity failed')
    return dict(constantColumnEnergyResidual_J=c['energy_J']-exact,uniformEntropyIdentity=res,
        uniformPressureDifference_Pa=same['topPressure_Pa']-a['topPressure_Pa'])

started=time.perf_counter();checks=independent_checks();cases=[]
# Temperatures are initial parcel entropy labels, not a solved inlet trajectory.
for name,temps,block in [('warm_below_cold_cap',[40.,290.,40.,40.],[0,1]),
    ('inverted_pair',[250.,290.,200.,40.],[0,1]),
    ('cooler_below_hot_cap',[290.,250.,280.,40.],[1,2])]:
    mm,ss,old=initial(temps,[.01,.01,.01,.97]);block=np.array(block)
    # Stability compares density after adiabatic displacement to ONE pressure.
    common=old['topPressure_Pa'];rhoBefore=[1/water_ps(common,s)[0] for s in ss]
    if not any(rhoBefore[i]>rhoBefore[i+1] for i in range(len(ss)-1)):raise ValueError('Test has no instability')
    new,final,ledger=solve_adjustment(mm,ss,old,block)
    rhoAfter=[1/water_ps(final['topPressure_Pa'],s)[0] for s in new]
    if any(rhoAfter[i]>rhoAfter[i+1]+1e-8 for i in range(len(ss)-1)):raise ValueError('Selected finite block did not restore stability')
    # Same actual mass/entropy inputs and target inventories, independently doubled quadrature.
    _,fine,_=solve_adjustment(mm,ss,old,block,n=16)
    dp=fine['topPressure_Pa']-final['topPressure_Pa']
    if abs(dp)>b['quadraturePressureDifference_Pa']:raise ValueError('Independent quadrature rejection')
    coarseWork=continuation(mm,ss,old,block,16);fineWork=continuation(mm,ss,old,block,32)
    if max(coarseWork['maximumNetBoundaryWork_J'],fineWork['maximumNetBoundaryWork_J'])>b['energyResidual_J'] or fineWork['maximumUnmergedWorkResidual_J']>b['unmergedWorkResidual_J'] or fineWork['minimumEntropyIncrement_J_K'] < -b['entropyTolerance_J_K']:
        raise ValueError('Continuation boundary-work/entropy rejection')
    cases.append(dict(name=name,block=block.tolist(),initial=old,final=final,ledger=ledger,
        commonPressureDensitiesBefore_kg_m3=rhoBefore,commonPressureDensitiesAfter_kg_m3=rhoAfter,
        quadraturePressureDifference_Pa=dp,continuation=[coarseWork,fineWork]))
mm,ss,stable=initial([290.,280.,250.,40.],[.01,.01,.01,.97])
if any(ss[i]<ss[i+1] for i in range(len(ss)-1)):raise ValueError('Stable identity fixture is unstable')
print(json.dumps(dict(scope='Finite globally conservative neutral-entropy adjustment, no admission or mixing time',checks=checks,
    stableNoActionFixture=stable,automaticBlockSelectionImplemented=False,cases=cases,finiteReferenceAccepted=True,physicalInletMixingQualified=False,
    transientAdmissionImplemented=False,wall_s=time.perf_counter()-started)))
`

if(import.meta.main) {
  const [page,python]=process.argv.slice(2)
  if(!page||!python)throw new Error('Usage: reference-design-cmt-adjustment.ts <wiki-page> <python>')
  const input=parseAdjustmentBasis(await Bun.file(page).text())
  const child=Bun.spawn([python,'-c',adjustmentCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(stderr)
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash:createHash('sha256').update(adjustmentCalculation).digest('hex'),...JSON.parse(stdout)},null,2))
}

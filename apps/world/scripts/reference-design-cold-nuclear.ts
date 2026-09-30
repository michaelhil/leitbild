/** Finite full-core source/feedback/poison evidence, not a plant runtime or startup solver. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { parseFuelConstruction, fuelGeometry } from './reference-design-fuel-construction'
import { parseSourceFeedback } from './reference-design-source-feedback'
import { advanceBank, parseBankBasis, type BankState } from './reference-design-bank-motion'
import { fuelMaterialPython } from './reference-design-fuel-materials'

const positive = z.number().finite().positive()
const negative = z.number().finite().negative()
const fraction = z.number().finite().min(0).max(1)
const coldSchema = z.object({ fuelRange_K: z.tuple([z.literal(300), z.literal(2000)]),
  dopplerWorth_pcm_sqrtK: negative, dopplerSensitivity_pcm_sqrtK: z.array(negative).min(2),
  waterWorth: positive, waterWorthChallenges: z.array(positive).min(2),
  absorberWorth_pcm_ppmEq: negative, absorberReference_ppmEq: positive,
  bankWorth: positive, bankReference: fraction, xenonWorth: negative,
  source: z.object({ identity: z.literal('LD01.CORE.SOURCE.CF252'), location: z.literal('complete-core dedicated nonfuel source guide'),
    birthEmission_neutrons_s: positive, halfLife_year: positive,
    couplingIntensity_per_neutron: positive, ageAtPreparation_year: z.number().finite().nonnegative(),
    couplingChallenges: z.array(positive).min(2) }).strict(),
  coldPreparation: z.object({ pressure_Pa: positive, temperature_K: z.literal(300),
    absorberConcentration_ppmEq: positive }).strict(),
  experiment: z.object({ sourceHold_s: positive, withdrawalTarget: fraction, withdrawalHold_s: positive,
    releaseWindow_s: positive, poisonHorizon_h: positive }).strict(),
}).strict()
const pmSchema = z.object({ promethiumHalfLife_h: positive, effectivePromethiumYield: positive,
  samariumAbsorption_barn: positive, samariumWorth: negative,
  samariumWorthChallenges: z.array(negative).min(2) }).strict()
const ixSchema = z.object({ iodineHalfLife_h: positive, xenonHalfLife_h: positive,
  iodineYield: positive, xenonYield: positive, xenonAbsorption_barn: positive,
  nominalFlux_m2_s: positive, normalizationVolume_m3: positive,
  recoverableEnergy_MeV: positive, nominalFission_MW: positive }).strict()
function block(doc: string, name: string): unknown {
  const blocks = [...doc.matchAll(new RegExp('^```' + name + '\\s*\\n([\\s\\S]*?)^```\\s*$', 'gm'))]
  if (blocks.length !== 1) throw Error(`Expected one ${name} block`)
  return JSON.parse(blocks[0]![1]!)
}
export function parseColdNuclear(document: string) {
  const basis = coldSchema.parse(block(document, 'reference-cold-nuclear'))
  if (!basis.waterWorthChallenges.includes(basis.waterWorth)
    || !basis.dopplerSensitivity_pcm_sqrtK.includes(basis.dopplerWorth_pcm_sqrtK)) throw Error('Nominal must be included in challenges')
  return basis
}

const calculation = String.raw`
import sys,json,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import quad,solve_ivp
from scipy.optimize import brentq
from scipy.linalg import expm
from CoolProp.CoolProp import PropsSI
${fuelMaterialPython}
d=json.load(sys.stdin);b=d['basis'];g=d['geometry'];p=d['ix'];m=d['pm'];c=d['kinetics']['source'];h=d['kinetics']['decay'];checks=[]
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
refs=[]
for order in ['2','4','8']:
    case=d['joined']['cases'][order];rows=case['rows'];mf=sum(r['fuelMass_kg'] for r in rows)
    require('consumed full fuel mass '+order,abs(mf-g['fuelMass_kg'])<1e-6,mass_kg=mf)
    D=0.;oldmean=0.;meanError=0.
    for r in rows:
        ts=r['TfuelSurface_K'];tc=r['TfuelCenter_K'];q=r['linePower_W_m'];mass=r['fuelMass_kg']
        if not 500<=ts<=tc<=2000 or not mass>0 or not q>0:raise ValueError('Invalid consumed material profile')
        def T(x):return brentq(lambda t:fk(t)-fk(ts)-q/(4*math.pi)*(1-x*x),ts-1e-7,tc+1e-7,xtol=1e-10)
        mean=quad(lambda x:2*x*T(x),0,1,epsabs=1e-9)[0]
        meanError=max(meanError,abs(mean-r['fuelMean_K']))
        D+=mass*quad(lambda x:2*x*math.sqrt(T(x)),0,1,epsabs=1e-10)[0]/mf
        oldmean+=mass*mean/mf
    require('consumed radial means '+order,meanError<2e-6,maximumDifference_K=meanError,rows=len(rows))
    refs.append(dict(order=int(order),fuelMass_kg=mf,Dref_sqrtK=D,oldMean_K=oldmean))
R=refs[-1];Dref=R['Dref_sqrtK'];Mref=d['joined']['cases']['8']['moderatorVolumeMeanDensity_kg_m3']*g['coreFlowVolume_m3']
require('joined reference accepted',d['joined']['accepted'] and d['joined']['projectionAccepted'])
require('profile quadrature converges',abs(refs[2]['Dref_sqrtK']-refs[1]['Dref_sqrtK'])<abs(refs[1]['Dref_sqrtK']-refs[0]['Dref_sqrtK']),references=refs)
require('mass mean square root is not square root mean',Dref<math.sqrt(R['oldMean_K']),difference_sqrtK=math.sqrt(R['oldMean_K'])-Dref)
beta=np.array(c['delayedFractions']);lam=np.log(2)/np.array(c['halfLives_s']);L=c['generationTime_s'];fra=np.array(h['fractions']);tau=np.array(h['timeConstants_s'])
li=math.log(2)/(3600*p['iodineHalfLife_h']);lx=math.log(2)/(3600*p['xenonHalfLife_h']);lp=math.log(2)/(3600*m['promethiumHalfLife_h'])
bx=p['xenonAbsorption_barn']*1e-28*p['nominalFlux_m2_s'];bs=m['samariumAbsorption_barn']*1e-28*p['nominalFlux_m2_s']
F0=p['nominalFission_MW']*1e6/(p['recoverableEnergy_MeV']*1e6*1.602176634e-19*p['normalizationVolume_m3'])
poisonref=[p['iodineYield']*F0/li,(p['iodineYield']+p['xenonYield'])*F0/(lx+bx),m['effectivePromethiumYield']*F0/lp,m['effectivePromethiumYield']*F0/bs]
yx=p['xenonYield']/(p['iodineYield']+p['xenonYield']);yi=1-yx
src=b['source'];sourceRate=src['birthEmission_neutrons_s']*src['couplingIntensity_per_neutron']*2**(-src['ageAtPreparation_year']/src['halfLife_year'])
sourceLambda=math.log(2)/(src['halfLife_year']*365.25*86400)
cold=b['coldPreparation'];coldrho=PropsSI('D','P',cold['pressure_Pa'],'T',cold['temperature_K'],'Water');uCold=coldrho*g['coreFlowVolume_m3']/Mref
def feedback(T=300.,u=uCold,C=1000.,x=0.,X=0.,Sm=0.,k=None,A=None,W=None):
    k=b['waterWorth'] if k is None else k;A=b['dopplerWorth_pcm_sqrtK'] if A is None else A;W=m['samariumWorth'] if W is None else W
    return k*(u-1)+b['absorberWorth_pcm_ppmEq']*1e-5*(C*u-b['absorberReference_ppmEq'])+A*1e-5*(math.sqrt(T)-Dref)+b['bankWorth']*(x-b['bankReference'])+b['xenonWorth']*(X-1)+W*(Sm-1)
screens=[]
for k in b['waterWorthChallenges']:
    for A in b['dopplerSensitivity_pcm_sqrtK']:
        for W in m['samariumWorthChallenges']:
            dry=feedback(u=0,C=0,x=1,k=k,A=A,W=W);inserted=feedback(k=k,A=A,W=W)
            screens.append(dict(waterWorth=k,dopplerWorth_pcm_sqrtK=A,samariumWorth=W,dryWorst_pcm=dry*1e5,coldNominalInserted_pcm=inserted*1e5,admitted=dry<0 and inserted<0))
nominal=feedback();dry=feedback(u=0,C=0,x=1);wet=feedback(C=0)
require('nominal cold inserted and dry screens',nominal<0 and dry<0,coldInserted_pcm=nominal*1e5,dryWorst_pcm=dry*1e5)
require('water-filled zero-absorber contrary remains',wet>0,reactivity_pcm=wet*1e5,promptCritical=bool(wet>sum(beta)))
require('rejected dry .12 family retained',any(q['waterWorth']==.12 and not q['admitted'] and q['dryWorst_pcm']>0 for q in screens))
require('nominal reference intercept retained',abs(feedback(T=Dref**2,u=1,C=1000,x=b['bankReference'],X=1,Sm=1))<1e-15)
temperatureCases=[dict(fuel_K=t,fuelWorth_pcm=b['dopplerWorth_pcm_sqrtK']*(math.sqrt(t)-Dref),nominalFilledInserted_pcm=feedback(T=t)*1e5) for t in [300,500,832.6426125612112,1200,2000]]
require('signed strictly decreasing full temperature response',all(temperatureCases[i]['fuelWorth_pcm']>temperatureCases[i+1]['fuelWorth_pcm'] for i in range(len(temperatureCases)-1)))
require('full domain derivative finite negative',all(b['dopplerWorth_pcm_sqrtK']/(2*math.sqrt(t))<0 for t in [300,500,2000]))
# Conditional P/T and complete-core isotope states, not an imposed achieved heatup.
reachability=[]
pt=b['experiment']['poisonHorizon_h']*3600;pm72=math.exp(-lp*pt);sm72=1+bs/lp*(1-pm72)
x72=math.exp(-lx*pt)+(lx+bx)*yi*(math.exp(-li*pt)-math.exp(-lx*pt))/(lx-li)
for tf,tw,pressure in [(300.,300.,.3e6),(450.,400.,2e6),(650.,500.,8e6),(Dref**2,578.0459020744466,15e6)]:
    ratio=PropsSI('D','P',pressure,'T',tw,'Water')*g['coreFlowVolume_m3']/Mref
    for label,X,Sm in [('fresh',0.,0.),('experienced-reference',1.,1.),('72h-zero-flux-poison',x72,sm72)]:
        rho0=feedback(T=tf,u=ratio,x=0.,X=X,Sm=Sm);critical=-rho0/b['bankWorth']
        require('conditional cold-hot bank reachable '+str(tw)+' '+label,0<critical<1)
        reachability.append(dict(label=label,fuelEquivalent_K=tf,coolant_K=tw,pressure_Pa=pressure,waterRatio=ratio,criticalBank=critical,inserted_pcm=rho0*1e5))

# Independent unnormalized precursor matrix plus source as an augmented decaying state.
scale=np.r_[1.,beta/(L*lam)]
def exactSource(rho,t,s=sourceRate,initial=None):
    A=np.zeros((8,8));A[0,0]=(rho-sum(beta))/L;A[0,1:7]=lam;A[1:7,0]=beta/L;A[1:7,1:7]=-np.diag(lam);A[0,7]=1;A[7,7]=-sourceLambda
    v=np.r_[np.zeros(7) if initial is None else initial*scale,s]
    return (expm(A*t)@v)[:7]/scale
def frozen_rhs(rho,s):
    return lambda t,y:np.r_[(rho*y[0]+beta@(y[1:7]-y[0]))/L+s*math.exp(-sourceLambda*t),lam*(y[0]-y[1:7])]
sourceComparisons=[]
for f in [0.,*src['couplingChallenges']]:
    s=sourceRate*f;exact=exactSource(nominal,b['experiment']['sourceHold_s'],s)
    out=solve_ivp(frozen_rhs(nominal,s),(0,b['experiment']['sourceHold_s']),np.zeros(7),method='Radau',rtol=1e-10,atol=1e-19)
    error=float(max(abs(out.y[:,-1]-exact)))
    require('independent physical precursor source '+str(f),out.success and error<1e-17,maxAbsoluteDifference=error)
    equilibrium=-L*s/nominal
    if f>0:require('positive source approaches conditional plateau '+str(f),exact[0]>0 and abs(exact[0]/equilibrium-1)<.002)
    else:require('missing source exact zero remains zero',max(abs(exact))==0 and max(abs(out.y[:,-1]))==0)
    sourceComparisons.append(dict(couplingFactor=f,nFinal=float(exact[0]),conditionalEquilibrium=equilibrium,shutdownRangeUsable=bool(1e-10<=exact[0]<=1e-2),thermalFission_W=float(exact[0]*p['nominalFission_MW']*1e6)))
eq=-L*sourceRate/nominal
removed=exactSource(nominal,b['experiment']['sourceHold_s'],0,np.full(7,eq))
require('separate absent-capsule held-bank discriminator',removed[0]<eq*.002,remainingIntensity=float(removed[0]),initialIntensity=eq)
# Source age is retained material history, not an operator amplitude knob.
sourceAgeCases=[]
for label,rho in [('nominal-cold-fresh',nominal),('hot-reference-inserted',-.07),('hot-after72h-poison',-.07+b['xenonWorth']*(x72-1)+m['samariumWorth']*(sm72-1))]:
    for factor in [1.,.25]:
        limit=src['halfLife_year']*math.log2((-L*sourceRate*factor/rho)/1e-10)
        for age in [0.,1.,src['halfLife_year']]:
            n=-L*sourceRate*factor*2**(-age/src['halfLife_year'])/rho
            sourceAgeCases.append(dict(label=label,couplingFactor=factor,additionalAge_year=age,conditionalIntensity=n,shutdownRangeUsable=bool(n>=1e-10),additionalAgeAtLowerRange_year=limit))

def rhs(t,y,x,T=300.,u=uCold,C=1000.,s=sourceRate,k=None,A=None,W=None):
    n=y[0];rho=feedback(T=T,u=u,C=C,x=x,X=y[14],Sm=y[16],k=k,A=A,W=W)
    return np.r_[(rho*n+beta@(y[1:7]-n))/L+s*math.exp(-sourceLambda*t),lam*(n-y[1:7]),(n-y[7:13])/tau,li*(n-y[13]),(lx+bx)*(yx*n+yi*y[13])-(lx+bx*n)*y[14],lp*(n-y[15]),bs*(y[15]-n*y[16])]
# Independent worst cold prepared-family corner: repeated finite requests accumulate
# before the existing logarithmic resolution can distinguish source-supported growth.
corners=[]
for q in screens:
    if q['admitted']:
        for X,Sm in [(0.,0.),(1.,1.),(x72,sm72)]:
            rho=feedback(k=q['waterWorth'],A=q['dopplerWorth_pcm_sqrtK'],W=q['samariumWorth'],X=X,Sm=Sm)
            corners.append((rho,q,X,Sm))
worst=min(corners,key=lambda z:(z[0],z[1]['samariumWorth']));rho0=worst[0];s=sourceRate*.25
groupInitial=-L*s/rho0;state=np.r_[np.full(13,groupInitial),1.,worst[2],1.,worst[3],math.log10(groupInitial)];time=0.;group=[]
for i in range(20):
    begin=.001*i
    def group_rhs(t,y):
        x=begin+min(d['bank']['ordinaryRate_s']*t,.001);q=worst[1]
        return np.r_[rhs(time+t,y[:17],x,s=s,k=q['waterWorth'],A=q['dopplerWorth_pcm_sqrtK'],W=q['samariumWorth']),(math.log10(y[0])-y[17])/.5]
    dt=.001/d['bank']['ordinaryRate_s']+60.
    out=solve_ivp(group_rhs,(0,dt),state,method='Radau',rtol=1e-10,atol=np.r_[np.full(17,1e-19),1e-10])
    require('bounded cumulative step '+str(i+1),out.success)
    state=out.y[:,-1];time+=dt
    group.append(dict(steps=i+1,target=.001*(i+1),acquiredLogIntensity=round(state[17]/.01)*.01,truthIntensity=float(state[0])))
first=round(math.log10(groupInitial)/.01)*.01;rise=group[-1]['acquiredLogIntensity']-first
trueRise=float(state[17]-math.log10(groupInitial))
require('worst declared cold cumulative approach resolves before finite cap',groupInitial>=1e-10 and rise>=.01 and trueRise>.02,initialIntensity=groupInitial,acquiredDelta_decade=rise,trueLaggedDelta_decade=trueRise)
groupEvidence=dict(initialCorner=dict(reactivity_pcm=rho0*1e5,parameters=worst[1],X=worst[2],Sm=worst[3]),sourceCouplingFactor=.25,initialIntensity=groupInitial,firstStepDelta_decade=group[0]['acquiredLogIntensity']-first,capStroke=.02,finalDelta_decade=rise,duration_s=time,samples=[group[i] for i in [0,4,9,19]],freshStuckObservation=dict(acquiredDelta_decade=0.,nextWithdrawalQualified=False))

require('all seventeen reference populations balance absent capsule',max(abs(rhs(0,np.ones(17),b['bankReference'],T=Dref**2,u=1,s=0)))<1e-13)
# Segment travel comes from the shared actual-mechanics owner; no target interpolation shortcut.
paths=[];ends=[]
for method in ['Radau','BDF']:
    y=np.zeros(17);time=0.;records=[];saved=None
    for name,segments in d['paths']:
        start=y.copy();local=[]
        for seg in segments:
            dt=seg['duration_s'];x0=seg['from'];x1=seg['to'];grid=np.linspace(0,dt,17)
            out=solve_ivp(lambda t,z:rhs(time+t,z,x0+(x1-x0)*t/dt),(0,dt),y,method=method,rtol=1e-9,atol=1e-18,t_eval=grid,max_step=5.)
            require(name+' '+method+' finite advance',out.success)
            require(name+' '+method+' retained nonnegative inventory',float(np.min(out.y))>-1e-18,minimum=float(np.min(out.y)))
            local.extend([dict(time_s=float(time+t),n=float(out.y[0,i]),bank=float(x0+(x1-x0)*t/dt),reactivity_pcm=float(feedback(x=x0+(x1-x0)*t/dt,X=out.y[14,i],Sm=out.y[16,i])*1e5)) for i,t in enumerate(grid)])
            y=out.y[:,-1];time+=dt
        records.append(dict(name=name,start=start.tolist(),final=y.tolist(),maximumIntensity=max(v['n'] for v in local),samples=[local[i] for i in sorted(set([0,len(local)//2,len(local)-1]))]))
        if name=='withdraw-and-hold':saved=(y.copy(),time)
    require('actual positive cold bank path '+method,records[1]['final'][0]>records[0]['final'][0]*2 and records[1]['samples'][-1]['reactivity_pcm']>0)
    require('healthy released insertion reduces source '+method,records[2]['final'][0]<records[1]['final'][0])
    # Same actual state with failed release retains the bank; distinct source, no fault schedule inside equations.
    prior,t0=saved
    fail=solve_ivp(lambda t,z:rhs(t0+t,z,b['experiment']['withdrawalTarget']),(0,b['experiment']['releaseWindow_s']),prior,method=method,rtol=1e-9,atol=1e-18)
    require('failed release grows rather than inserts '+method,fail.success and fail.y[0,-1]>prior[0])
    # A small positive delivered request and HOLD, using lagged/quantized existing NI semantics.
    stepInitial=np.r_[prior,math.log10(prior[0])]
    stepDuration=.001/d['bank']['ordinaryRate_s']+60.
    def step_rhs(t,z):
        x=b['experiment']['withdrawalTarget']+min(t*d['bank']['ordinaryRate_s'],.001)
        return np.r_[rhs(t0+t,z[:17],x),(math.log10(z[0])-z[17])/.5]
    step=solve_ivp(step_rhs,(0,stepDuration),stepInitial,method=method,rtol=1e-9,atol=np.r_[np.full(17,1e-18),1e-9])
    first=round(stepInitial[17]/.01)*.01;last=round(step.y[17,-1]/.01)*.01
    delta=last-first;period=stepDuration/(math.log(10)*delta) if delta>0 else None
    require('small actual positive request and HOLD is observable '+method,step.success and delta>=.01 and period is not None and period>=60,acquiredDelta_decade=delta,indicatedPeriod_s=period)
    # Same truthful movement with a fresh, plausible constant acquired value supplies no growth evidence.
    unresolved=dict(acquiredDelta_decade=0.,indicatedPeriod_s=None,nextWithdrawalQualified=False)
    paths.append(dict(method=method,records=records,failedReleaseFinal=fail.y[:,-1].tolist(),smallStep=dict(commandIncrement=.001,actualTravel=.001,hold_s=60.,initialIntensity=float(prior[0]),finalIntensity=float(step.y[0,-1]),acquiredDelta_decade=delta,indicatedPeriod_s=period),freshConstantObservation=unresolved))
    ends.append(np.r_[*[r['final'] for r in records],fail.y[:,-1]])
error=float(max(abs(ends[0]-ends[1])));require('distinct stiff complete-history realizations',error<2e-14,maxAbsoluteDifference=error)
# Continuing capsule after actual inserted bank: thermal boundaries remain prescribed.
duration=b['experiment']['poisonHorizon_h']*3600;long=[]
for method in ['Radau','BDF']:
    out=solve_ivp(lambda t,y:rhs(t,y,0.),(0,duration),np.ones(17),method=method,rtol=1e-10,atol=1e-17,max_step=7200.,dense_output=True)
    require('72h continuing-source '+method,out.success and min(out.y[:,-1])>=0)
    long.append(out)
require('72h complete histories distinct realizations',max(abs(long[0].y[:,-1]-long[1].y[:,-1]))<2e-8,maxNormalizedDifference=float(max(abs(long[0].y[:,-1]-long[1].y[:,-1]))))
checkpoint=long[0].sol(duration/2)
copied=solve_ivp(lambda t,y:rhs(t+duration/2,y,0.),(0,duration/2),checkpoint.copy(),method='Radau',rtol=1e-10,atol=1e-17,max_step=7200.)
require('copy retains all17 populations and actual source age',copied.success and max(abs(copied.y[:,-1]-long[0].y[:,-1]))<2e-8,maxNormalizedDifference=float(max(abs(copied.y[:,-1]-long[0].y[:,-1]))))
longHistory=dict(initial=np.ones(17).tolist(),checkpoint36h=checkpoint.tolist(),final72h=long[0].y[:,-1].tolist(),sourceAgeIncrement_year=duration/(365.25*86400),finalReactivity_pcm=float(feedback(X=long[0].y[14,-1],Sm=long[0].y[16,-1])*1e5))

# Independent prescribed-fission isotope affine matrices: no achieved 72h cooling claim.
histories=[]
def poison_rhs(z,n):return np.array([li*(n-z[0]),(lx+bx)*(yx*n+yi*z[0])-(lx+bx*n)*z[1],lp*(n-z[2]),bs*(z[2]-n*z[3])])
def isotope_exact(z,n,t):
    A=np.zeros((5,5));A[0,0]=-li;A[0,4]=li*n;A[1,0]=(lx+bx)*yi;A[1,1]=-(lx+bx*n);A[1,4]=(lx+bx)*yx*n;A[2,2]=-lp;A[2,4]=lp*n;A[3,2]=bs;A[3,3]=-bs*n
    return (expm(A*t)@np.r_[z,1.])[:4]
initial=np.ones(4)
for label,n,t in [('zero-flux-72h',0.,duration),('restart-prescribed-0.2',.2,3600.),('nominal-flux-burn-sign',1.,3600.)]:
    exact=isotope_exact(initial,n,t)
    a=solve_ivp(lambda t,z:poison_rhs(z,n),(0,t),initial,method='Radau',rtol=1e-10,atol=1e-11)
    z=solve_ivp(lambda t,z:poison_rhs(z,n),(0,t),initial,method='BDF',rtol=1e-10,atol=1e-11)
    error=max(float(max(abs(a.y[:,-1]-exact))),float(max(abs(z.y[:,-1]-exact))))
    require(label+' independent physical affine history',a.success and z.success and error<2e-7,maxNormalizedDifference=error)
    histories.append(dict(name=label,prescribedFission=n,initial=initial.tolist(),final=exact.tolist(),reactivityPoison_pcm=float((b['xenonWorth']*(exact[1]-1)+m['samariumWorth']*(exact[3]-1))*1e5)))
    if n==0:require('stable samarium accumulates instead of decaying',exact[3]>1 and exact[2]<1)
    elif n==.2:require('low-power restart can still accumulate samarium',exact[3]>initial[3],initialSm=float(initial[3]),finalSm=float(exact[3]),initialPm=float(initial[2]))
    else:require('sufficient actual flux burns samarium',exact[3]<initial[3],initialSm=float(initial[3]),finalSm=float(exact[3]),initialPm=float(initial[2]))
    initial=exact
stable=poison_rhs(np.array([0.,0.,0.,2.]),0.)
require('zero-flux stable samarium has exact zero derivative',stable[3]==0)
print(json.dumps(dict(scope='Conditional full-core operational feedback/source and retained poison prerequisite; prescribed cold liquid/material and finite actual bank boundaries, not whole-plant startup, empirical nuclear validation, partial-core/pool criticality or 72h cooling endurance',reference=dict(**R,waterMass_kg=Mref,coldDensity_kg_m3=coldrho,coldWaterRatio=uCold,poisonNumberDensity_m3=poisonref,sourceIntensity_s=sourceRate),screens=screens,temperatureCases=temperatureCases,conditionalReachability=reachability,sourceComparisons=sourceComparisons,sourceAgeCases=sourceAgeCases,cumulativeApproach=groupEvidence,paths=paths,longContinuingSource=longHistory,poisonHistories=histories,checks=checks,packages=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,CoolProp=CoolProp.__version__)),allow_nan=False))
`

export async function runColdNuclear(owners: Record<string, string>, joined: unknown, python: string) {
  const basis = parseColdNuclear(owners['cold-source-and-startup.md']!)
  const bank = parseBankBasis(owners['control-and-verification.md']!)
  if (basis.bankWorth !== bank.worthPerStroke || basis.bankReference !== bank.referencePosition) throw Error('Bank/source design identity mismatch')
  const support = { holdingVoltage: true, ordinaryDrive: true, releaseAvailable: true, insertionStop: 0 }
  const before: BankState = { position: 0, mode: 'HOLD', requestedPosition: 0, released: false }
  const held = advanceBank(bank, before, support, basis.experiment.sourceHold_s)
  const moved = advanceBank(bank, { ...held.state, mode: 'MANUAL', requestedPosition: basis.experiment.withdrawalTarget }, support,
    basis.experiment.withdrawalTarget / bank.ordinaryRate_s + basis.experiment.withdrawalHold_s)
  const released = advanceBank(bank, moved.state, { ...support, holdingVoltage: false }, basis.experiment.releaseWindow_s)
  const fuel = parseFuelConstruction(owners['fuel-construction.md']!)
  const data = { basis, bank, geometry: fuelGeometry(fuel), joined,
    kinetics: parseSourceFeedback(owners['kinetics.md']!, owners['heat-and-history.md']!),
    ix: ixSchema.parse(block(owners['shutdown-and-fuel-response.md']!, 'reference-iodine-xenon')),
    pm: pmSchema.parse(block(owners['shutdown-and-fuel-response.md']!, 'reference-promethium-samarium')),
    paths: [['source-hold', held.segments], ['withdraw-and-hold', moved.segments], ['released-insertion', released.segments]] }
  const child = Bun.spawn([python, '-c', calculation], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(JSON.stringify(data)); child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(stderr || stdout)
  return { calculationSha256: createHash('sha256').update(calculation).digest('hex'),
    inputSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), ...JSON.parse(stdout) }
}
if (import.meta.main) {
  const [directory, joinedPath, python, output, ...extra] = Bun.argv.slice(2)
  if (!directory || !joinedPath || !python || !output || extra.length) throw Error('Usage: bun reference-design-cold-nuclear.ts <reactor-directory> <joined-material-receipt.json> <research-python> <receipt.json>')
  const names = ['cold-source-and-startup.md', 'kinetics.md', 'heat-and-history.md', 'shutdown-and-fuel-response.md', 'control-and-verification.md', 'fuel-construction.md']
  const paths = [...names.map(n => resolve(directory, n)), joinedPath, import.meta.path,
    ...['fuel-construction', 'fuel-materials', 'bank-motion', 'source-feedback'].map(n => new URL('./reference-design-' + n + '.ts', import.meta.url).pathname)]
  const before = await Promise.all(paths.map(p => Bun.file(p).text()))
  const owners = Object.fromEntries(names.map((n, i) => [n, before[i]!]))
  const result = await runColdNuclear(owners, JSON.parse(before[names.length]!), python)
  const after = await Promise.all(paths.map(p => Bun.file(p).text()))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Consumed engineering inputs changed during calculation')
  await Bun.write(output, JSON.stringify({ identities: paths.map((p, i) => ({ file: p.split('/').pop(), sha256: createHash('sha256').update(before[i]!).digest('hex') })), ...result }, null, 2) + '\n')
}

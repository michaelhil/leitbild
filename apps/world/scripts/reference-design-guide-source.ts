/** Actual fresh seated-guide inventory into retained full-core source; not pool neutronics. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {coldNuclearOwnerRecords} from './reference-design-cold-nuclear'
const positive=z.number().finite().positive(),amount=z.number().finite().nonnegative()
const schema=z.object({activeExternalWater_kg:positive,activeGuideWater_kg:positive,
 activeExternalMobileTracer_kgEq:amount,activeGuideMobileTracer_kgEq:amount,activeRetainedTracer_kgEq:amount,
 fuelTemperature_K:z.literal(300),freshSourceVector:z.array(z.literal(0)).length(17),
 capsule:z.object({identity:z.literal('LD01.CORE.SOURCE.CF252'),age_year:amount}).strict()}).strict()
export function parseGuideSourceInput(v:unknown){return schema.parse(v)}
export const guideSourceCalculation=String.raw`
import json,sys,math,platform
import numpy as np,scipy
from scipy.integrate import solve_ivp
from scipy.linalg import expm
d=json.load(sys.stdin);b=d['basis'];c=d['kinetics']['source'];h=d['kinetics']['decay'];p=d['ix'];m=d['pm'];r=d['reference'];g=d['guide'];checks=[]
def require(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
Mref=r['waterMass_kg'];Dref=r['Dref_sqrtK'];u=(g['activeExternalWater_kg']+g['activeGuideWater_kg'])/Mref
tracer=1e6*(g['activeExternalMobileTracer_kgEq']+g['activeGuideMobileTracer_kgEq']+g['activeRetainedTracer_kgEq'])/Mref
uold=g['activeExternalWater_kg']/Mref;bold=1e6*g['activeExternalMobileTracer_kgEq']/Mref
def rho(T=300.,x=0.,X=0.,Sm=0.,k=None,A=None,W=None,water=u,absorber=tracer):
 k=b['waterWorth'] if k is None else k;A=b['dopplerWorth_pcm_sqrtK'] if A is None else A;W=m['samariumWorth'] if W is None else W
 return k*(water-1)+b['absorberWorth_pcm_ppmEq']*1e-5*(absorber-b['absorberReference_ppmEq'])+A*1e-5*(math.sqrt(T)-Dref)+b['bankWorth']*(x-b['bankReference'])+b['xenonWorth']*(X-1)+W*(Sm-1)
delta=rho()-rho(water=uold,absorber=bold)
require('new guide water/tracer really changes response without reference reset',delta>0,change_pcm=delta*1e5)
require('original complete reference intercept unchanged',abs(rho(T=Dref**2,x=b['bankReference'],X=1,Sm=1,water=1,absorber=b['absorberReference_ppmEq']))<1e-15)
beta=np.array(c['delayedFractions']);lam=np.log(2)/np.array(c['halfLives_s']);L=c['generationTime_s'];tau=np.array(h['timeConstants_s'])
li=math.log(2)/(3600*p['iodineHalfLife_h']);lx=math.log(2)/(3600*p['xenonHalfLife_h']);lp=math.log(2)/(3600*m['promethiumHalfLife_h'])
bx=p['xenonAbsorption_barn']*1e-28*p['nominalFlux_m2_s'];bs=m['samariumAbsorption_barn']*1e-28*p['nominalFlux_m2_s'];yi=p['iodineYield']/(p['iodineYield']+p['xenonYield']);yx=1-yi
src=b['source'];decay=math.log(2)/(src['halfLife_year']*365.25*86400);s0=src['birthEmission_neutrons_s']*src['couplingIntensity_per_neutron']*2**(-g['capsule']['age_year']/src['halfLife_year'])
pm72=math.exp(-lp*72*3600);sm72=1+bs/lp*(1-pm72)
x72=math.exp(-lx*72*3600)+(lx+bx)*yi*(math.exp(-li*72*3600)-math.exp(-lx*72*3600))/(lx-li)
histories=[('fresh',0.,0.),('reference-experienced',1.,1.),('72h-zero-flux-comparison',x72,sm72)]
families=[];corners=[]
for k in b['waterWorthChallenges']:
 for A in b['dopplerSensitivity_pcm_sqrtK']:
  for W in m['samariumWorthChallenges']:
   inserted=rho(T=b['fuelRange_K'][0],k=k,A=A,W=W);dry=rho(T=b['fuelRange_K'][0],x=1,k=k,A=A,W=W,water=0,absorber=0)
   q=dict(waterWorth=k,dopplerWorth_pcm_sqrtK=A,samariumWorth=W,inserted290_pcm=inserted*1e5,dry290_pcm=dry*1e5,admitted=inserted<0 and dry<0);families.append(q)
   if q['admitted']:
    for T in [290.,300.]:
     for label,X,Sm in histories:corners.append((rho(T=T,k=k,A=A,W=W,X=X,Sm=Sm),q,T,label,X,Sm))
require('revised nominal parameter family retains inserted and dry authority',all(q['admitted'] for q in families if q['waterWorth']==b['waterWorth']))
require('least negative actual nominal family corner reported',max(q['inserted290_pcm'] for q in families if q['waterWorth']==b['waterWorth'])<0,leastNegativeInserted_pcm=max(q['inserted290_pcm'] for q in families if q['waterWorth']==b['waterWorth']))
require('revised guide geometry retains credible dilution contrary',rho(T=290,absorber=0)>0,reactivity_pcm=rho(T=290,absorber=0)*1e5)
require('dry rejected family remains rejected rather than tuned',all(not q['admitted'] for q in families if q['waterWorth']==.12))
def rhs(t,y,x,T=300.,k=None,A=None,W=None,s=s0):
 n=y[0];reactivity=rho(T=T,x=x,X=y[14],Sm=y[16],k=k,A=A,W=W)
 return np.r_[(reactivity*n+beta@(y[1:7]-n))/L+s*math.exp(-decay*t),lam*(n-y[1:7]),(n-y[7:13])/tau,li*(n-y[13]),(lx+bx)*(yx*n+yi*y[13])-(lx+bx*n)*y[14],lp*(n-y[15]),bs*(y[15]-n*y[16])]
initial=np.array(g['freshSourceVector'],dtype=float);ends=[]
for method in ['Radau','BDF']:
 out=solve_ivp(lambda t,y:rhs(t,y,0),(0,600),initial.copy(),method=method,rtol=1e-10,atol=1e-20,max_step=5)
 require('actual fresh zero17-state source advancement '+method,out.success and np.min(out.y)>=-1e-20 and out.y[0,-1]>1e-10,finalIntensity=float(out.y[0,-1]))
 ends.append(out.y[:,-1])
require('actual fresh source histories agree distinct stiff realizations',max(abs(ends[0]-ends[1]))<1e-16,maxDifference=float(max(abs(ends[0]-ends[1]))))
missing=solve_ivp(lambda t,y:rhs(t,y,0,s=0),(0,600),initial.copy(),method='Radau',rtol=1e-10,atol=1e-20)
require('physical missing capsule does not seed a fresh source',missing.success and max(abs(missing.y[:,-1]))==0)
worst=min(corners,key=lambda v:v[0]);rr,q,T,label,X,Sm=worst;s=s0*.25
n0=-L*s/rr
state=np.r_[np.full(13,n0),1.,X,1.,Sm,math.log10(n0)];time=0.;samples=[]
# This separate conditional worst-history coupon is NOT the actual fresh parent.
for i in range(20):
 begin=.001*i;duration=.001/d['bank']['ordinaryRate_s']+60
 def step(t,y):
  x=begin+min(d['bank']['ordinaryRate_s']*t,.001)
  return np.r_[rhs(time+t,y[:17],x,T=T,k=q['waterWorth'],A=q['dopplerWorth_pcm_sqrtK'],W=q['samariumWorth'],s=s),(math.log10(y[0])-y[17])/.5]
 out=solve_ivp(step,(0,duration),state,method='Radau',rtol=1e-10,atol=np.r_[np.full(17,1e-20),1e-10]);require('changed guide worst NI step '+str(i+1),out.success)
 state=out.y[:,-1];time+=duration
 samples.append(dict(step=i+1,target=.001*(i+1),intensity=float(state[0]),acquiredLogIntensity=round(state[17]/.01)*.01))
first=round(math.log10(n0)/.01)*.01;rise=samples[-1]['acquiredLogIntensity']-first
require('changed guide most negative NI corner usable and bounded approach resolves',n0>=1e-10 and rise>=.01,initialIntensity=n0,reactivity_pcm=rr*1e5,acquiredRise_decade=rise)
require('first unresolved small step is not false criticality proof',samples[0]['acquiredLogIntensity']-first<.01)
ages=[]
for factor in src['couplingChallenges']:
 for age in [0.,src['halfLife_year'],2*src['halfLife_year']]:
  n=-L*s0*factor*2**(-age/src['halfLife_year'])/rr
  ages.append(dict(couplingFactor=factor,additionalAge_year=age,intensity=n,sourceRangeUsable=bool(1e-10<=n<=1e-2)))
require('actual source ageing/coupling can defeat NI authority',any(not q['sourceRangeUsable'] for q in ages))
newCritical=-rho()/b['bankWorth'];oldCritical=-rho(water=uold,absorber=bold)/b['bankWorth']
require('changed critical bank is real not restored old critical intercept',0<newCritical<1 and newCritical<oldCritical,actualFreshCriticalBank=newCritical,externalOnlyCriticalBank=oldCritical)
print(json.dumps(dict(scope='Fresh revised complete-core effective all-water join and separate conditional NI challenge, not partial/pool criticality, achieved startup, inherited experienced guide history or absolute nuclear margin',reference=r,actualWaterRatio=u,actualAbsorberProxy_ppmEq=tracer,guideChange_pcm=delta*1e5,nominalInserted300_pcm=rho()*1e5,families=families,freshSource=dict(initial=initial.tolist(),final600s=ends[0].tolist(),capsule=g['capsule'],sourceAgeIncrement_year=600/(365.25*86400)),conditionalWorstNI=dict(history=label,fuel_K=T,parameters=q,reactivity_pcm=rr*1e5,initialIntensity=n0,sourceCouplingFactor=.25,capStroke=.02,duration_s=time,acquiredRise_decade=rise,samples=[samples[j] for j in [0,4,9,19]],freshStuckNextWithdrawalQualified=False),sourceAging=ages,checks=checks,packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__)),allow_nan=False))
`
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
if(import.meta.main){
 const [directory,referencePath,parentPath,python,output,...extra]=Bun.argv.slice(2)
 if(!directory||!referencePath||!parentPath||!python||!output||extra.length)throw Error('Usage: guide-source <reactor> <accepted-cold-reference.json> <guide-parent.json> <research-python> <receipt.json>')
 const names=['cold-source-and-startup.md','kinetics.md','heat-and-history.md','shutdown-and-fuel-response.md','control-and-verification.md']
 const docs=await Promise.all(names.map(n=>Bun.file(`${directory}/${n}`).text())),owners=Object.fromEntries(names.map((n,i)=>[n,docs[i]!]))
 const referenceText=await Bun.file(referencePath).text(),parentText=await Bun.file(parentPath).text(),reference=JSON.parse(referenceText),parent=JSON.parse(parentText)
 const ref=z.object({Dref_sqrtK:positive,waterMass_kg:positive,fuelMass_kg:positive}).parse(reference.reference)
 const data={...coldNuclearOwnerRecords(owners),reference:ref,guide:parseGuideSourceInput(parent.sourceInput)}
 if(data.basis.source.identity!==data.guide.capsule.identity||data.basis.source.ageAtPreparation_year!==data.guide.capsule.age_year)throw Error('Capsule source identity/age mismatch')
 if(data.basis.bankWorth!==data.bank.worthPerStroke||data.basis.bankReference!==data.bank.referencePosition)throw Error('Bank reference/worth mismatch')
 const serialized=JSON.stringify(data),proc=Bun.spawn([python,'-c',guideSourceCalculation],{stdin:new Blob([serialized]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 await Bun.write(output,JSON.stringify({calculationSHA256:sha(guideSourceCalculation),inputSHA256:sha(serialized),acceptedReferenceReceiptSHA256:sha(referenceText),guideParentReceiptSHA256:sha(parentText),owners:Object.fromEntries(names.map((n,i)=>[n,sha(docs[i]!)])),input:data,...JSON.parse(out)},null,2)+'\n')
 const result=JSON.parse(out)
 console.log(JSON.stringify({receipt:output,checks:result.checks.length,guideChange_pcm:result.guideChange_pcm,nominalInserted300_pcm:result.nominalInserted300_pcm}))
}

/** Offline SG NC/contact and primary coastdown constitutive screen; no station solve. */
import {createHash} from 'node:crypto'
import {sgContactBasis} from './reference-design-sg-contact'
import {gasConstants} from './reference-design-service-pump-mixture'
import {poolBoilingPython} from './reference-design-pool-boiling'
import {nativePoolContactPython} from './reference-design-native-pool-contact'

export const sgServiceContactPython=String.raw`
import sys,json,math,functools
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,least_squares
d=json.load(sys.stdin);geo=d['contact'];g=9.80665;sb=5.670374419e-8;b={'surfaceFactor':1.}
${poolBoilingPython}
${nativePoolContactPython}
D=geo['diameter_m'];A=geo['area_m2'];eps=geo['effectiveEmissivity'];checks=[]
R={j:d['gas'][j]['R'] for j in d['gas']};cv={j:d['gas'][j]['cv'] for j in d['gas']}
def check(name,value,expected=0,tol=1e-7):
 if not math.isfinite(value) or abs(value-expected)>tol:raise ValueError((name,value,expected,tol))
 checks.append(dict(name=name,value=value,expected=expected,tolerance=tol))
def liquid_prop(k,p,T):
 Ts=sat(p)['T']
 if T>Ts+1e-7:raise ValueError('Stable liquid required')
 return P(k,'P',p,'Q',0,'Water') if abs(T-Ts)<1e-7 else P(k,'P',p,'T',T,'Water')
def mixture(T,Vg,ma,mn,V=1):
 pv=P('P','T',T,'Q',1,'Water');p=pv+(ma*R['air']+mn*R['nitrogen'])*T/Vg
 rl=liquid_prop('D',p,T);ul=liquid_prop('U',p,T);rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water')
 ml=(V-Vg)*rl;mv=Vg*rv
 return dict(T=T,p=p,pv=pv,V=V,Vg=Vg,alphaLiquid=(V-Vg)/V,water=ml+mv,liquid=ml,steam=mv,air=ma,nitrogen=mn,rhoLiquid=rl,rhoSteam=rv,rhoGas=(mv+ma+mn)/Vg,rhoMixture=(ml+mv+ma+mn)/V,U=ml*ul+mv*uv+(ma*cv['air']+mn*cv['nitrogen'])*(T-298.15))
def prepare(T,pNC,Vg=.4):
 return mixture(T,Vg,pNC*.5*Vg/(R['air']*T),pNC*.5*Vg/(R['nitrogen']*T))
def gas_contact(T,Tw,p,pv,rhov,factor=1):
 sensible=factor*geo['gasSensible_W_m2K']*(Tw-T)
 cond=0.;demand=0.;dew=None
 if pv>0 and rhov>0:
  dew=P('T','P',pv,'Q',1,'Water')
  if Tw<dew:
   # Existing PRHR density-driving effective contact; not a resolved diffusion film.
   rs=P('D','T',Tw,'Q',1,'Water');demand=.01*max(0,rhov-rs)
   if demand:
    hv=P('H','P',pv,'T',T,'Water') if abs(T-dew)>1e-7 else P('H','P',pv,'Q',1,'Water')
    hl=P('H','P',p,'T',Tw,'Water')
    if hv<=hl:raise ValueError('Nonpositive condensation enthalpy drop')
    cond=demand*(hv-hl)
 return dict(heatIntoFluid_W_m2=sensible-cond,sensibleIntoFluid_W_m2=sensible,condensationToMetal_W_m2=cond,equivalentCondensationDemand_kg_m2s=demand,dew_K=dew,phaseMassSource=0)
def secondary_wet(s,Tw):
 # Actual fluid T stays authoritative. No dissolved/entrained NC is supplied to
 # hypothetical nucleating steam bubbles; their pressure is liquid mechanical p.
 q,regime=contacted(s['p'],s['T'],Tw,D,epsilon=eps)
 return dict(heatIntoFluid_W_m2=q,regime=regime,bubblePressure_Pa=s['p'],actualLiquid_K=s['T'],bubbleSaturation_K=sat(s['p'])['T'],dew_K=P('T','P',s['pv'],'Q',1,'Water'))
def primary_film(p,T,Tw,u):
 # Source-informed stable-liquid property convention: liquid-side wall/film
 # evaluation reaches saturation, never a silently metastable liquid property.
 Ts=sat(p)['T'];Tref=min(Tw,Ts);Tf=.5*(T+Tref)
 rho,mu,k,cp,beta=[liquid_prop(key,p,T) for key in ['D','V','L','C','ISOBARIC_EXPANSION_COEFFICIENT']]
 muw,kw,cpw=[liquid_prop(key,p,Tref) for key in ['V','L','C']]
 rf=liquid_prop('D',p,Tf);pr=mu*cp/k;prw=muw*cpw/kw;raw_ratio=pr/prw
 # INL Eq.230 bounds the empirical correction, not the native fluid state.
 ratio=min(20.,max(.05,raw_ratio))
 re=rho*abs(u)*D/mu;ra=g*beta*abs(Tw-T)*D**3/(mu/rf)**2*pr
 nc=max(.59*ra**.25,.13*ra**(1/3));turb=0.
 if re>1000:
  f=(1.58*math.log(re)-3.28)**-2
  turb=(f/2)*(re-1000)*pr/(1+12.7*math.sqrt(f/2)*(pr**(2/3)-1))*ratio**.11
 nu=max(3.66,nc,turb)
 return dict(h_W_m2K=nu*k/D,ReLiquid=re,NuLaminar=3.66,NuNatural=nc,NuTurbulent=turb,PrRatioRaw=raw_ratio,PrRatioUsed=ratio,commonVelocity_m_s=u)
def primary_liquid(p,T,Tw,u):
 f=primary_film(p,T,Tw,u);h=f['h_W_m2K'];q,onset=wet_state(p,T,Tw,D,h)
 if Tw<=onset:return dict(**f,heatIntoFluid_W_m2=q,regime='sensible-liquid',boilingEndpointsEvaluated=False)
 # Existing core interpretation: pool boiling scale bounds the BOILING increment,
 # not arbitrary sensible heat of strongly subcooled, forced liquid contact.
 sp=sat(p);qbmax=.131*(sp['hv']-sp['hl'])*math.sqrt(sp['rv'])*(g*sp['sigma']*(sp['rl']-sp['rv']))**.25*math.sqrt(sp['rl']/(sp['rl']+sp['rv']))
 def pre(wall):
  hh=primary_film(p,T,wall,u)['h_W_m2K'];qw,on=wet_state(p,T,wall,D,hh)
  return qw,qw-hh*(wall-T)
 tm=minimum_film(p,T);tc=brentq(lambda wall:pre(wall)[1]-qbmax,T,tm)
 peak=pre(tc)[0];qm=film(p,tm,D,eps)
 if not T<tc<tm or not 0<qm<peak:raise ValueError('Primary thermal endpoint applicability exit')
 if Tw<=tc:mode='boiling'
 elif Tw<tm:
  w=((Tw-tm)/(tc-tm))**2;q=w*peak+(1-w)*qm;mode='transition'
 else:q=film(p,Tw,D,eps);mode='film'
 return dict(**f,heatIntoFluid_W_m2=q,regime=mode,boilingEndpointsEvaluated=True,Tturn_K=tc,Tmin_K=tm,qPeak_W_m2=peak,qmin_W_m2=qm,boilingIncrementLimit_W_m2=qbmax)
def primary_contact(s,Tw,m):
 alpha=s['alphaLiquid'];u=m/(s['rhoMixture']*1.25)
 wetpart=primary_liquid(s['p'],s['T'],Tw,u) if alpha>0 else None
 gaspart=gas_contact(s['T'],Tw,s['p'],s['pv'],s['rhoSteam']) if alpha<1 else None
 q=alpha*(wetpart['heatIntoFluid_W_m2'] if wetpart else 0)+(1-alpha)*(gaspart['heatIntoFluid_W_m2'] if gaspart else 0)
 return dict(commonVelocity_m_s=u,liquidExposure=alpha,liquid=wetpart,gas=gaspart,heatIntoFluid_W_m2=q)
T6=sat(6e6)['T'];Tw=geo['nominalWall_C']+273.15
ncRows=[]
for pn in [0,1e4,1e6,6e6,14e6]:
 s=prepare(T6,pn);q=secondary_wet(s,Tw);cold=gas_contact(s['T'],s['T']-20,s['p'],s['pv'],s['rhoSteam'])
 check('NC addition does not change fixed-T dew point',q['dew_K'],T6,1e-7)
 check('NC gas contact has no duplicate phase source',cold['phaseMassSource'])
 ncRows.append(dict(state=s,wet=q,coldGas=cold))
q0=contacted(6e6,T6,Tw,D,epsilon=eps)[0]
check('zero-NC exact prior pure-water contact',ncRows[0]['wet']['heatIntoFluid_W_m2'],q0,1e-5)
endpointRows=[]
for total,pv in [(6e6,1e5),(6e6,1e6),(6e6,3e6),(15.2e6,6e6),(20e6,6e6)]:
 s=prepare(sat(pv)['T'],total-pv)
 try:
  tc,tm,qc,qm=endpoints(s['p'],s['T'],D,epsilon=eps)
  endpointRows.append(dict(totalPressure_Pa=total,vaporPressure_Pa=pv,actualLiquid_K=s['T'],TCHF_K=tc,Tmin_K=tm,qCHF_W_m2=qc,qmin_W_m2=qm,admitted=True))
 except Exception as error:endpointRows.append(dict(totalPressure_Pa=total,vaporPressure_Pa=pv,admitted=False,error=str(error)))
gasRows=[]
for delta in [-50,0,50]:
 row=gas_contact(400,400+delta,1e6,0,0)
 check('steam-free gas sensible endpoint',row['heatIntoFluid_W_m2'],5*delta)
 check('steam-free gas has no condensation',row['equivalentCondensationDemand_kg_m2s'])
 gasRows.append(row)
dry=dict(T=600.,p=2e6,pv=1e6,rhoSteam=P('D','P',1e6,'T',600,'Water'),alphaLiquid=0,rhoMixture=P('D','P',1e6,'T',600,'Water')+1e6/(R['nitrogen']*600))
gasOnly=primary_contact(dry,420,100)
check('gas-only primary has no phantom liquid contact',gasOnly['liquidExposure'])
primaryRows=[];p=14.7e6;T=593.15;rho=liquid_prop('D',p,T)
pure=dict(p=p,T=T,pv=0,rhoSteam=0,alphaLiquid=1,rhoMixture=rho)
for m in [8821.130657,882.1130657,0,-8821.130657]:
 row=primary_contact(pure,Tw,m)
 if row['liquid']['boilingEndpointsEvaluated']:raise ValueError('Cold wall must not evaluate unused CHF')
 row.update(massFlow_kg_s=m,wholeAreaLocalConductance_W_K=row['liquid']['h_W_m2K']*A,oldDistributedConductance_W_K=81.171802e6)
 primaryRows.append(row)
check('primary flow reversal preserves film',primaryRows[0]['heatIntoFluid_W_m2'],primaryRows[-1]['heatIntoFluid_W_m2'],1e-7)
check('primary zero-temperature heat',primary_contact(pure,T,0)['heatIntoFluid_W_m2'])
mixed=prepare(sat(3e6)['T'],3e6,Vg=.5)
mixedPrimary=primary_contact(mixed,523.15,100)
check('phase Reynolds uses common velocity',mixedPrimary['liquid']['ReLiquid'],mixed['rhoLiquid']*abs(mixedPrimary['commonVelocity_m_s'])*D/liquid_prop('V',mixed['p'],mixed['T']),1e-7)
hotPrimary=primary_liquid(6e6,473.15,573.15,8821.130657/(liquid_prop('D',6e6,473.15)*1.25))
# Local finite NC source transaction: equal/opposite heat from 1m² wall, native
# receiver M/U recovered independently; no imposed temperature or Γ added.
s=prepare(473.15,3e6);wall=573.15;Cwall=geo['metalCapacity_J_K']/A
heat=secondary_wet(s,wall)['heatIntoFluid_W_m2']*.01
target=s['U']+heat
def residual(x):
 r=mixture(x[0],x[1],s['air'],s['nitrogen'])
 return [(r['water']-s['water'])/s['water'],(r['U']-target)/target]
fit=least_squares(residual,[s['T']+.01,s['Vg']],bounds=([s['T']-5,.1],[s['T']+5,.9]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
if not fit.success:raise ValueError(('Finite NC native recovery failed',fit.message))
after=mixture(*fit.x,s['air'],s['nitrogen']);wallAfter=wall-heat/Cwall
check('finite NC receiver water',after['water'],s['water'],1e-6)
check('finite NC receiver energy',after['U'],target,.1)
check('finite NC paired wall/fluid energy',(after['U']-s['U'])+Cwall*(wallAfter-wall),0,.1)
check('finite NC retained air',after['air'],s['air'])
check('finite NC retained nitrogen',after['nitrogen'],s['nitrogen'])
print(json.dumps(dict(scope='Fixed-state effective SG contact selection and one local NC native-energy transaction; no station, coastdown time history, gas-film calibration, acquired observations or cooling qualification',basis=d,ncWet=ncRows,ncEndpoints=endpointRows,steamFreeGas=gasRows,gasOnlyPrimary=gasOnly,primaryLiquid=primaryRows,mixedPrimary=mixedPrimary,hotPrimary=hotPrimary,finiteNcTransaction=dict(before=s,after=after,heat_J=heat,wallBefore_K=wall,wallAfter_K=wallAfter,area_m2=1,durationInterpretation='0.01s initial-rate source transaction, not time integration'),checks=checks,versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),sort_keys=True,allow_nan=False))
`

if(import.meta.main){
 const [python,output,...rest]=process.argv.slice(2)
 if(!python||!output||rest.length)throw Error('Usage: sg-service-contact <research-python> <receipt.json>')
 const names=['reference-design-sg-contact.ts','reference-design-service-pump-mixture.ts','reference-design-pool-boiling.ts','reference-design-native-pool-contact.ts']
 const source=await Bun.file(import.meta.path).text(),deps=Object.fromEntries(await Promise.all(names.map(async n=>[n,await Bun.file(new URL(n,import.meta.url)).text()])))
 const input={contact:sgContactBasis,gas:gasConstants},hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const proc=Bun.spawn([python,'-c',sgServiceContactPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 if(await Bun.file(import.meta.path).text()!==source)throw Error('Source changed during calculation')
 for(const n of names)if(await Bun.file(new URL(n,import.meta.url)).text()!==deps[n])throw Error('Dependency changed during calculation')
 const result={sourceSha256:hash(source),calculationSha256:hash(sgServiceContactPython),inputSha256:hash(JSON.stringify(input)),dependencies:Object.fromEntries(names.map(n=>[n,hash(deps[n]!)])),...JSON.parse(out)}
 await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({output,checks:result.checks.length,endpointAdmissions:result.ncEndpoints.map((r:{admitted:boolean})=>r.admitted),primaryConductances:result.primaryLiquid.map((r:{wholeAreaLocalConductance_W_K:number})=>r.wholeAreaLocalConductance_W_K)}))
}

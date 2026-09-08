/** Offline finite-pressure thermal apparatus; no reactor/runtime imports. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
const positive=z.number().finite().positive()
const schema=z.object({design:z.literal('LD-01-bulk-condensation'),pressure_MPa:z.literal(5),
  initialVolume_m3:positive,initialVoidFraction:positive.max(.1),initialBubbleDiameter_m:positive,
  minimumDiameter_m:positive,relativeVelocity_m_s:positive,hydraulicDiameter_m:positive,
  duration_s:positive,steps_s:z.tuple([positive,positive,positive]),
}).strict().superRefine((b,c)=>{
  if(b.minimumDiameter_m>=b.initialBubbleDiameter_m||b.initialBubbleDiameter_m>=.9*b.hydraulicDiameter_m||
    b.steps_s[0]!==2*b.steps_s[1]||b.steps_s[1]!==2*b.steps_s[2])
    c.addIssue({code:'custom',message:'Require ordered bubble dimensions and three halved timesteps'})
})
export function parseBulkCondensation(document:string){
  const blocks=[...document.matchAll(/^```reference-bulk-condensation\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-bulk-condensation block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export const bulkCondensationCalculation=String.raw`
import sys,json,math,platform,time
import numpy as np
import iapws
from iapws import IAPWS97 as W
from iapws.iapws97 import _Region1,_Region2
from scipy.optimize import brentq
from scipy.integrate import quad
b=json.load(sys.stdin);p=b['pressure_MPa'];pPa=p*1e6;g=9.80665
f=W(P=p,x=0);v=W(P=p,x=1);Ts=f.T;hf=f.h*1000;hg=v.h*1000;hfg=hg-hf
checks=[]
class AdmissionError(ValueError):pass
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
def phase(h,vapor):
    fn=_Region2 if vapor else _Region1;T=Ts
    for _ in range(12):
        w=fn(T,p);err=w['h']*1000-h
        if abs(err)<1e-7:break
        T-=err/(w['cp']*1000)
    else:raise ValueError('Phase enthalpy inversion did not converge')
    if (vapor and T<Ts-1e-9) or (not vapor and T>Ts+1e-9):raise AdmissionError('Phase outside stable branch')
    obj=W(P=p,T=T) if abs(T-Ts)>1e-8 else (v if vapor else f)
    return dict(T=T,rho=1/w['v'],cp=w['cp']*1000,k=obj.k,mu=obj.mu)
def run(name,sub,sup,dtMax):
    li=W(P=p,T=Ts-sub);va=W(P=p,T=Ts+sup) if sup else v
    Ml0=(1-b['initialVoidFraction'])*b['initialVolume_m3']*li.rho
    Mv0=b['initialVoidFraction']*b['initialVolume_m3']*va.rho;M=Ml0+Mv0
    N=b['initialVoidFraction']*b['initialVolume_m3']/(math.pi*b['initialBubbleDiameter_m']**3/6)
    X=np.array([Ml0*(hf-li.h*1000),Mv0*(va.h*1000-hg)])
    C=Mv0*hfg+X[1]-X[0];H0=M*hf+C
    def state(xx):
        if min(xx)<0:raise AdmissionError('Negative sensible energy trial')
        Mv=(C-xx[1]+xx[0])/hfg;Ml=M-Mv
        if not 0<Mv<M:raise AdmissionError('Trial phase disappearance')
        Hl=Ml*hf-xx[0];Hv=Mv*hg+xx[1]
        l=phase(Hl/Ml,False);a=phase(Hv/Mv,True)
        Vl=Ml/l['rho'];Vv=Mv/a['rho'];alpha=Vv/(Vl+Vv)
        diameter=(6*Vv/(math.pi*N))**(1/3);area=N*math.pi*diameter**2
        terminal=math.sqrt(2)*(f.sigma*g*(l['rho']-a['rho'])/l['rho']**2)**.25*(1-alpha)**1.39
        ur=min(b['relativeVelocity_m_s'],terminal)
        Re=l['rho']*ur*diameter/l['mu'];Pr=l['cp']*l['mu']/l['k']
        Nu=2+.6*math.sqrt(Re)*Pr**(1/3);hl=l['k']*Nu/diameter
        Ql=area*hl*(l['T']-Ts);Qv=area*1000*(a['T']-Ts);Gamma=(Ql+Qv)/hfg
        return dict(Mv=Mv,Ml=Ml,Hl=Hl,Hv=Hv,Ul=Hl-pPa*Vl,Uv=Hv-pPa*Vv,
            Vl=Vl,Vv=Vv,Tl=l['T'],Tv=a['T'],diameter=diameter,area=area,alpha=alpha,
            Ql=Ql,Qv=Qv,Gamma=Gamma,Re=Re,Nu=Nu,relativeVelocity=ur)
    def advance(xx,step):
        a=state(xx);mid=xx+.5*step*np.array([a['Ql'],-a['Qv']]);m=state(mid)
        out=xx+step*np.array([m['Ql'],-m['Qv']]);return out,state(out),m
    initial=state(X);old=initial;t=0.;steps=0;rejected=0;rows=[];maxE=0.;maxM=0.;maxPhase=0.
    phaseSources=np.zeros(2);start=time.perf_counter();event=None
    def record():
        rows.append(dict(t_s=t,liquid_C=old['Tl']-273.15,vapor_C=old['Tv']-273.15,
            vaporMass_kg=old['Mv'],liquidMass_kg=old['Ml'],volume_m3=old['Vl']+old['Vv'],
            bubbleDiameter_m=old['diameter'],interfaceArea_m2=old['area'],voidFraction=old['alpha'],
            condensation_kg_s=-old['Gamma'],liquidToInterface_W=old['Ql'],vaporToInterface_W=old['Qv']))
    record()
    while t<b['duration_s']-1e-12:
        nextSample=(math.floor((t+1e-10)/.01)+1)*.01
        step=min(dtMax,b['duration_s']-t,nextSample-t)
        # Positivity restriction follows actual transfer rates, not a startup schedule.
        for inventory,rate in [(old['Mv'],old['Gamma']),(X[0],old['Ql']),(X[1],-old['Qv'])]:
            if rate<0 and inventory>0:step=min(step,.1*inventory/(-rate))
        for attempt in range(30):
            try:newX,new,mid=advance(X,step);break
            except AdmissionError:step*=.5;rejected+=1
        else:raise ValueError('No admissible finite-bath step')
        if not step>0 or t+step==t:raise ValueError('Finite-bath timestep cannot advance')
        if new['diameter']<b['minimumDiameter_m']:
            upper=t+step
            step=brentq(lambda s:advance(X,s)[1]['diameter']-b['minimumDiameter_m'],0,step,xtol=1e-14)
            newX,new,mid=advance(X,step)
            event=dict(kind='selected diameter stop, not measured collapse',bracket_s=[t,upper],located_s=t+step)
        S=np.array([-mid['Gamma']*hf-mid['Ql'],mid['Gamma']*hg-mid['Qv']])
        phaseSources+=step*S
        phaseResidual=np.array([new['Ul']-old['Ul']+pPa*(new['Vl']-old['Vl']),
            new['Uv']-old['Uv']+pPa*(new['Vv']-old['Vv'])])-step*S
        maxPhase=max(maxPhase,float(max(abs(phaseResidual))))
        maxM=max(maxM,abs(new['Ml']+new['Mv']-M),abs(new['Mv']-old['Mv']-step*mid['Gamma']))
        maxE=max(maxE,abs(new['Hl']+new['Hv']-H0),abs(new['Ul']+new['Uv']-initial['Ul']-initial['Uv']+
            pPa*(new['Vl']+new['Vv']-initial['Vl']-initial['Vv'])))
        require('accepted phase work and conservation',maxM<1e-12 and maxE<1e-6 and maxPhase<1e-6,
            massError_kg=maxM,energyError_J=maxE,phaseEnergyError_J=maxPhase)
        X=newX;old=new;t+=step;steps+=1
        if event or abs(t/.01-round(t/.01))<1e-8:record()
        if event:break
    if C>=0:
        endpoint=dict(kind='saturated residual vapor',vaporMass_kg=C/hfg,temperature_C=Ts-273.15)
        require('residual vapor never consumed',old['Mv']>=C/hfg-1e-12)
    else:
        endpoint=dict(kind='all liquid thermodynamic endpoint; collapse timing unqualified',
            vaporMass_kg=0.,temperature_C=W(P=p,h=H0/M/1000).T-273.15)
        require('diameter stop located',event is not None and abs(old['diameter']-b['minimumDiameter_m'])<1e-10)
    return dict(name=name,dtMax_s=dtMax,bubbleNumber=N,initialMass_kg=M,initialEnthalpy_J=H0,
        initialVaporLatent_J=Mv0*hfg,initialLiquidDeficit_J=Ml0*(hf-li.h*1000),
        endpoint=endpoint,event=event,rows=rows,steps=steps,rejectedTrials=rejected,
        maxMassError_kg=maxM,maxEnergyError_J=maxE,maxPhaseWorkError_J=maxPhase,
        integratedPhaseSources_J=phaseSources.tolist(),wall_s=time.perf_counter()-start)
cases=[]
for name,sub,sup in [('cold',5.,0.),('warm',.1,0.),('superheated',5.,5.)]:
    for dt in b['steps_s']:cases.append(run(name,sub,sup,dt))
comparisons=[]
for name in ['cold','warm','superheated']:
    a,c=[r for r in cases if r['name']==name][1:]
    require('same event presence across refinement',(a['event'] is None)==(c['event'] is None))
    common={round(r['t_s'],10):r for r in c['rows']}
    deltaT=0.;deltaM=0.;count=0
    for r in a['rows']:
        s=common.get(round(r['t_s'],10))
        if s is None:continue # Located stop times are compared separately, not paired as trajectories.
        count+=1;deltaT=max(deltaT,abs(r['liquid_C']-s['liquid_C']),abs(r['vapor_C']-s['vapor_C']))
        deltaM=max(deltaM,abs(r['vaporMass_kg']-s['vaporMass_kg']))
    deltaEvent=abs(a['event']['located_s']-c['event']['located_s']) if a['event'] else 0.
    expected=math.floor((min(a['rows'][-1]['t_s'],c['rows'][-1]['t_s'])+1e-9)/.01)+1
    require('complete common output grid',count==expected,actual=count,expected=expected)
    require('independent timestep screen',count>2 and deltaT<.01 and deltaM<1e-6 and deltaEvent<1e-4,
        temperature_K=deltaT,vaporMass_kg=deltaM,eventTime_s=deltaEvent,commonSamples=count)
    comparisons.append(dict(name=name,temperature_K=deltaT,vaporMass_kg=deltaM,eventTime_s=deltaEvent,commonSamples=count))
# Separate ideal Nu=2 infinite-bath, fixed-property spherical condensation limit.
# Integrate dM/|Gamma(M)| after the substitution M=M0*y^3, regular at y=0.
r0=.001;sub=.01;k=f.k;rho=v.rho;M0=4*math.pi*r0**3*rho/3
exact=rho*hfg*r0*r0/(2*k*sub)
def timeIntegrand(y):
    if y==0:return 0.
    R=r0*y;area=4*math.pi*R*R;Nu=2.;htc=Nu*k/(2*R)
    rate=area*htc*sub/hfg
    return 3*M0*y*y/rate
integrated=quad(timeIntegrand,0,1,epsabs=1e-10,epsrel=1e-12)[0]
require('independent Nu2 mass-coordinate collapse time',abs(integrated-exact)<1e-10)
analytic=dict(scope='constant-property saturated-vapor infinite-bath limit only',
    Jakob=f.rho*f.cp*1000*sub/(v.rho*hfg),initialRadius_m=r0,subcooling_K=sub,
    collapseTime_s=exact,integratedMassCoordinateTime_s=integrated,
    vanishedVaporMass_kg=M0,latentTransfer_J=M0*hfg,finalVaporMass_kg=0.)
print(json.dumps(dict(scope='fixed-pressure finite-bath interphase candidate, not empirical channel qualification',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__),cases=cases,
    comparisons=comparisons,analytic=analytic,checks=checks,empiricalChannelQualified=False,
    rigidCellImplemented=False,wallBoilingConnected=False),allow_nan=False))
`
if(import.meta.main){
  const [page,python,...extra]=process.argv.slice(2)
  if(!page||!python||extra.length)throw Error('Usage: reference-design-bulk-condensation.ts <owner-page> <isolated-python>')
  const input=parseBulkCondensation(await Bun.file(page).text())
  const proc=Bun.spawn([python,'-c',bulkCondensationCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited])
  if(status!==0)throw Error(err)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({inputHash:hash(JSON.stringify(input)),calculationHash:hash(bulkCondensationCalculation),...JSON.parse(out)},null,2))
}

/** Offline three-store pressure/thermal interface, not a plant or runtime extension. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBasis } from './reference-design-pressurizer.ts'
const positive=z.number().finite().positive()
const schema=z.object({hotVolume_m3:positive,lineLength_m:positive,lineDiameter_m:positive,
  initialLiquid_C:z.number().finite().min(275).max(325),referenceFlow_kg_s:positive,referenceLoss_Pa:positive,
  duration_s:positive,pulse_s:positive,heat_W:positive,steps_s:z.tuple([positive,positive,positive]),
  phaseCells:z.number().int().min(2).max(32),axialConductivityBound_W_mK:positive,
}).strict().superRefine((b,c)=>{
  if(b.pulse_s>=b.duration_s||b.steps_s[0]!==2*b.steps_s[1]||b.steps_s[1]!==2*b.steps_s[2]||
    b.steps_s.some(dt=>[b.pulse_s,b.duration_s,.2].some(t=>Math.abs(t/dt-Math.round(t/dt))>1e-8)))
    c.addIssue({code:'custom',message:'Pulse, output and end must align on three halved timestep grids'})
})
export function parseSurgeBasis(document:string,pzrDocument:string){
  const blocks=[...document.matchAll(/^```reference-surge\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-surge block')
  return {surge:schema.parse(JSON.parse(blocks[0]![1]!)),pzr:parsePressurizerBasis(pzrDocument)}
}
export const surgeCalculation=String.raw`
import sys,json,math,time,platform
import numpy as np
import scipy,iapws
from scipy.optimize import root,brentq
from iapws.iapws97 import _Region1,_Region2,_TSat_P,_PSat_T
d=json.load(sys.stdin);b=d['surge'];v=d['pzr'];g=9.80665
A=v['area_m2'];V=v['volume_m3'];z0=v['bottomElevation_m'];p0=v['hotPortPressure_MPa']*1e6
T0=b['initialLiquid_C']+273.15;pipeA=math.pi*b['lineDiameter_m']**2/4
lineV=pipeA*b['lineLength_m'];volumes=np.array([b['hotVolume_m3'],lineV])
checks=[]
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
def liquid(p,T):
    if not 14e6<p<16e6 or not 548.15<T<623.15 or p<=_PSat_T(T)*1e6:raise ValueError('Outside compressed-liquid surge study')
    w=_Region1(T,p/1e6);rho=1/w['v'];h=w['h']*1000
    return dict(rho=rho,h=h,u=h-p/rho)
rhoref=liquid(p0,T0)['rho'];K=b['referenceLoss_Pa']/b['referenceFlow_kg_s']**2

def column(ps,height,n):
    if not 14e6<=ps<=16e6 or not 0<height<V/A:raise ValueError('Outside two-phase column study')
    T=_TSat_P(ps/1e6);totals=np.zeros(2);ports={};hydroError=0.
    for name,H,sign,fn in [('liquid',height,-1,_Region1),('vapor',V/A-height,1,_Region2)]:
        dz=H/n;pf=ps;phaseMass=0.
        for j in range(n):
            pc=pf
            for _ in range(12):
                w=fn(T,pc/1e6);rho=1/w['v'];rp=rho*w['kt']/1e6
                defect=pc-pf+sign*.5*g*dz*rho
                pc-=defect/(1+sign*.5*g*dz*rp)
                if abs(defect)<1e-6:break
            w=fn(T,pc/1e6);rho=1/w['v'];h=w['h']*1000;u=h-pc/rho
            defect=pc-pf+sign*.5*g*dz*rho;hydroError=max(hydroError,abs(defect))
            if abs(defect)>1e-5:raise ValueError('Hydrostatic column solve failed')
            z=z0+height+sign*(j+.5)*dz;M=rho*A*dz;phaseMass+=M
            totals+=np.array([M,M*(u+g*z)])
            pf-=sign*g*dz*rho
        # Actual endpoint property from the same isothermal hydrostatic column.
        w=fn(T,pf/1e6);ports[name]=dict(p=pf,rho=1/w['v'],h=w['h']*1000,mass=phaseMass)
    return dict(M=totals[0],E=totals[1],bottom=ports['liquid'],top=ports['vapor'],T=T,p=ps,height=height,hydroError=hydroError)

def solve(fun,guess):
    r=fun(guess)
    if max(abs(r))<1e-8:return guess.copy(),float(max(abs(r)))
    result=root(fun,guess,tol=1e-12);r=fun(result.x)
    if not np.all(np.isfinite(result.x)) or max(abs(r))>1e-8:raise ValueError('Connected residual failed: '+str(result.message)+' '+str(r.tolist()))
    return result.x,float(max(abs(r)))

def run(name,dt,sign,n):
    height=v['liquidVolume_m3']/A
    ps=brentq(lambda p:column(p,height,n)['bottom']['p']-p0,14e6,15.5e6,xtol=1e-5)
    x=np.array([p0/1e7,T0/600,p0/1e7,T0/600,ps/1e7,height/6,0.,0.])
    def evaluate(xx):
        hot=liquid(xx[0]*1e7,xx[1]*600);line=liquid(xx[2]*1e7,xx[3]*600);tank=column(xx[4]*1e7,xx[5]*6,n)
        q=xx[6:]*20;M=np.array([hot['rho']*volumes[0],line['rho']*volumes[1],tank['M']])
        E=np.array([M[0]*(hot['u']+g*z0),M[1]*(line['u']+g*z0),tank['E']])
        dp=np.array([xx[0]*1e7-xx[2]*1e7,xx[2]*1e7-tank['bottom']['p']])
        donors=[hot if q[0]>=0 else line,line if q[1]>=0 else tank['bottom']]
        H=np.array([donor['h']+g*z0 for donor in donors])
        flux=q*H;dM=np.array([-q[0],q[0]-q[1],q[1]])
        dE=np.array([-flux[0],flux[0]-flux[1],flux[1]])
        hyd=dp-np.array([.5*K*q[i]*abs(q[i])*rhoref/donors[i]['rho'] for i in range(2)])
        return dict(M=M,E=E,dM=dM,dE=dE,hyd=hyd,q=q,tank=tank,H=H,hot=hot,line=line)
    initial=evaluate(x);old=initial;t=0.;ledger=0.;maxM=0.;maxE=0.;maxR=0.;samples=[]
    maxLocal=np.zeros(8)
    def record():
        samples.append(dict(t_s=t,hotPressure_MPa=x[0]*10,linePressure_MPa=x[2]*10,pzrPressure_MPa=x[4]*10,
            hot_C=x[1]*600-273.15,line_C=x[3]*600-273.15,pzr_C=old['tank']['T']-273.15,
            height_m=x[5]*6,hotToLine_kg_s=old['q'][0],lineToPzr_kg_s=old['q'][1],
            hotMass_kg=old['M'][0],lineMass_kg=old['M'][1],pzrMass_kg=old['M'][2]))
    record();start=time.perf_counter()
    while t<b['duration_s']-1e-9:
        step=min(dt,b['duration_s']-t);Q=sign*b['heat_W'] if t<b['pulse_s']-1e-9 else 0.
        def residual(trial):
            e=evaluate(trial);powers=e['dE']+np.array([Q,0.,0.])
            return np.r_[((e['M']-old['M'])/step-e['dM'])/20,((e['E']-old['E'])/step-powers)/b['heat_W'],e['hyd']/b['referenceLoss_Pa']]
        x,r=solve(residual,x)
        maxLocal=np.maximum(maxLocal,abs(residual(x))*np.array([20,20,20,b['heat_W'],b['heat_W'],b['heat_W'],b['referenceLoss_Pa'],b['referenceLoss_Pa']]))
        old=evaluate(x);ledger+=Q*step;t+=step
        maxR=max(maxR,r);maxM=max(maxM,abs(sum(old['M'])-sum(initial['M'])))
        maxE=max(maxE,abs(sum(old['E'])-sum(initial['E'])-ledger))
        require('accepted conservation',maxM<1e-5 and maxE<10,massError_kg=maxM,energyError_J=maxE)
        if abs(t/.2-round(t/.2))<1e-8:record()
    if sign==0:require('admitted no-exchange hold',max(abs(x[:6]-np.array([p0/1e7,T0/600,p0/1e7,T0/600,ps/1e7,height/6])))<1e-7)
    else:require('unclamped signed surge',sign*samples[round(b['pulse_s']/.2)]['lineToPzr_kg_s']>0)
    return dict(name=name,dt_s=dt,phaseCells=n,initialMass_kg=float(sum(initial['M'])),initialEnergy_J=float(sum(initial['E'])),
        initialPzrPressure_MPa=ps/1e6,initialPzrEnergy_J=initial['tank']['E'],
        maxLocalMassResidual_kg_s=maxLocal[:3].tolist(),maxLocalEnergyResidual_W=maxLocal[3:6].tolist(),maxHeadResidual_Pa=maxLocal[6:].tolist(),
        samples=samples,maxMassError_kg=maxM,maxEnergyError_J=maxE,maxResidual=maxR,wall_s=time.perf_counter()-start)

results=[run('hold',b['steps_s'][0],0,b['phaseCells'])]
for sign,name in [(1,'expansion'),(-1,'contraction')]:
    for dt in b['steps_s']:results.append(run(name,dt,sign,b['phaseCells']))
def compare(a,c):
    differences={key:0. for key in a['samples'][0] if key!='t_s'}
    if len(a['samples'])!=len(c['samples']):raise ValueError('Missing common times')
    for s,f in zip(a['samples'],c['samples']):
        if abs(s['t_s']-f['t_s'])>1e-8:raise ValueError('Unaligned times')
        for key in differences:differences[key]=max(differences[key],abs(s[key]-f[key]))
    return differences
refinement=[]
for name in ['expansion','contraction']:
    cases=[r for r in results if r['name']==name];deltas=compare(cases[1],cases[2]);refinement.append(dict(name=name,differences=deltas))
    require('fine temporal refinement',max(v for k,v in deltas.items() if 'Pressure' in k)<.001 and
        max(v for k,v in deltas.items() if k.endswith('_C'))<.05 and
        max(v for k,v in deltas.items() if k.endswith('_kg_s'))<.1,differences=deltas)
fineColumn=run('expansion_column_refined',b['steps_s'][2],1,2*b['phaseCells'])
spatial=compare(results[3],fineColumn)
require('hydrostatic spatial refinement',max(v for k,v in spatial.items() if 'Pressure' in k)<.0001 and
    max(v for k,v in spatial.items() if k.endswith('_C'))<.001,differences=spatial)
# Independently compare summed columns with continuous hydrostatic integration at initial state.
from scipy.integrate import solve_ivp
pinit=results[0]['initialPzrPressure_MPa']*1e6;T=_TSat_P(pinit/1e6);height=v['liquidVolume_m3']/A
continuous=np.zeros(2)
for H,sign,fn in [(height,-1,_Region1),(V/A-height,1,_Region2)]:
    def rhs(z,y):
        w=fn(T,y[0]/1e6);rho=1/w['v'];u=w['h']*1000-y[0]/rho
        return [-rho*g,rho*A,rho*A*(u+g*z)]
    s=solve_ivp(rhs,(z0+height,z0+height+sign*H),[pinit,0.,0.],method='DOP853',rtol=1e-11,atol=[1e-5,1e-9,1e-3])
    if not s.success:raise ValueError('Independent hydrostatic integral failed')
    continuous+=sign*s.y[1:,-1]
col=column(pinit,height,b['phaseCells']);quad=dict(massDifference_kg=col['M']-continuous[0],energyDifference_J=col['E']-continuous[1])
require('independent column quadrature',abs(quad['massDifference_kg'])<.01 and abs(quad['energyDifference_J'])<1000,**quad)
print(json.dumps(dict(scope='Finite HOT.A/surge/PZR insulated exchange limit, not full primary circuit or stratified surge qualification',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),input=d,
    lineVolume_m3=lineV,referenceDensity_kg_m3=rhoref,results=results,refinement=refinement,columnRefined=fineColumn,
    columnComparison=spatial,independentHydrostatic=quad,checks=checks,
    axialWaterConductionBound_W=b['axialConductivityBound_W_mK']*pipeA*(T-T0)/b['lineLength_m'],
    countercurrentExchangeRepresented=False,fullPrimaryConnected=False),allow_nan=False))
`
if(import.meta.main){
  const [page,pzrPage,python]=process.argv.slice(2)
  if(!page||!pzrPage||!python)throw Error('Usage: reference-design-surge.ts <surge-page> <pzr-page> <research-python>')
  const input=parseSurgeBasis(await Bun.file(page).text(),await Bun.file(pzrPage).text())
  const p=Bun.spawn([python,'-c',surgeCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if(status!==0)throw Error(err)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({inputHash:hash(JSON.stringify(input)),calculationHash:hash(surgeCalculation),...JSON.parse(out)},null,2))
}

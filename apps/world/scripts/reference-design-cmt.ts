/** Finite liquid CMT apparatus, not a production plant solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({
  design: z.literal('LD-01'), duration_s: positive, output_s: positive,
  initialPressure_MPa: positive, primaryVolume_m3: positive,
  hot_C: z.number().finite(), cold_C: z.number().finite(),
  layers: z.number().int().min(2).max(16),
  interlayerConductance_W_K: z.number().finite().nonnegative(),
  relativeTolerance: positive, maximumStep_s: positive,
}).strict().superRefine((b,c)=>{
  if(b.hot_C<=b.cold_C || b.output_s>b.duration_s || b.relativeTolerance>=1e-3)
    c.addIssue({code:'custom',message:'Invalid thermal, output or accuracy basis'})
  if(b.duration_s<=40||b.maximumStep_s>b.output_s||[20,40,b.duration_s].some(t=>Math.abs(t/b.output_s-Math.round(t/b.output_s))>1e-8))
    c.addIssue({code:'custom',message:'Study must include aligned power loss/restoration and independent timestep refinement'})
})
export function parseCmtBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-fixture\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-cmt-fixture JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const cmtLiquidDefinitions = String.raw`
import json,sys,math,platform
import numpy as np
import scipy,iapws
from scipy.optimize import root
from iapws.iapws97 import _Region1,_PSat_T
b=json.load(sys.stdin); g=9.80665
# SI properties and exact region-one derivatives. Fixed region is deliberate;
# reaching its liquid boundary is not repaired with another phase or clipping.
def water(p,T):
    if not 273.15<T<623.15 or not .1e6<p<30e6 or p<=_PSat_T(T)*1e6:
        raise ValueError('CMT apparatus reached its admitted compressed-liquid domain')
    w=_Region1(T,p/1e6); rho=1/w['v']; h=w['h']*1000; u=h-p/rho
    rp=rho*w['kt']/1e6; rt=-rho*w['alfav']
    up=(p*w['kt']/1e6-T*w['alfav'])/rho
    ut=w['cp']*1000-p*w['alfav']/rho
    return rho,u,h,rp,rt,up,ut

# Each vessel owns one top pressure plus layer temperatures. The 1 m3
# balance-line store is the first (zero-height) layer of each CMT, not a
# fabricated resistor between numerical strata. CMT hydrostatic pressure
# equality and continuity determine internal flows.
def vessel(volumes,heights,centers,top):
    return dict(V=np.array(volumes),H=np.array(heights),z=np.array(centers),top=top)
def make(N):
    main=vessel([b['primaryVolume_m3']],[0],[3.],3.)
    tank=vessel([1.]+[60/N]*N,[0.]+[6/N]*N,[12.]+[12-(j+.5)*6/N for j in range(N)],12.)
    dvi=vessel([.5],[0],[3.],3.)
    return [main,tank,dvi,tank,dvi]

def state(v,y):
    pf=y[0]
    rows=[]; mass=[]; energy=[]
    for j,(V,H,z,T) in enumerate(zip(v['V'],v['H'],v['z'],y[1:])):
        p=pf
        for _ in range(8):
            w=water(p,T);r,u,h,rp,rt,up,ut=w
            delta=(p-pf-.5*g*H*r)/(1-.5*g*H*rp);p-=delta
            if abs(delta)<1e-5:break
        w=water(p,T);r,u,h,rp,rt,up,ut=w
        if not math.isfinite(p+r) or abs(p-pf-.5*g*H*r)>1e-6:
            raise ValueError('CMT hydrostatic layer pressure did not converge')
        M=r*V;E=M*(u+g*z)
        mass.append(M);energy.append(E)
        rows.append(dict(p=p,T=T,rho=r,h=h,M=M,z=z))
        pf=pf+g*H*r
    return dict(rows=rows,M=np.array(mass),E=np.array(energy),
                ptop=y[0],pbottom=pf,ztop=v['top'],zbottom=v['top']-sum(v['H']))
`

const cmtRunCalculation = String.raw`
def run(name,N,tol,maxstep,blocked=False,stuck=False):
    vs=make(N);sizes=[len(v['V'])+1 for v in vs];cuts=np.cumsum([0]+sizes)
    p0=b['initialPressure_MPa']*1e6;hot=b['hot_C']+273.15;cold=b['cold_C']+273.15
    rh=water(p0,hot)[0];rc=water(p0,cold)[0]
    # Balance top is connected to the hot source at +3 m through a +9 m rise.
    pt=p0-rh*g*9
    for _ in range(8):
        rt,_,_,rp,*_=water(pt,hot)
        defect=pt-p0+.5*(rh+rt)*g*9
        pt-=defect/(1+.5*rp*g*9)
        if abs(defect)<1e-7:break
    if abs(pt-p0+.5*(rh+water(pt,hot)[0])*g*9)>1e-6:
        raise ValueError('Initial balance connection is not in hydrostatic equilibrium')
    y0=[]
    for k,v in enumerate(vs):
        if k in (1,3):y0.extend([pt,hot]+[cold]*N)
        else:y0.extend([p0,hot])
    physical=len(y0);y0=np.array(y0)
    def unpack(y):return [state(v,y[cuts[k]:cuts[k+1]]) for k,v in enumerate(vs)]
    initial=unpack(y0);M0=sum(sum(s['M']) for s in initial);E0=sum(sum(s['E']) for s in initial)
    scale=np.array([1e7 if i in cuts[:-1] else 500. for i in range(physical)])
    x=np.concatenate([y0/scale,np.zeros(6+2*N)])
    trace=[];em=0.;ee=0.;nfev=0;delivered=np.zeros(2);maxdefect=0.
    def check_balance(ss):
        nonlocal em,ee
        M=sum(sum(s['M']) for s in ss);E=sum(sum(s['E']) for s in ss)
        em=max(em,abs(M-M0));ee=max(ee,abs(E-E0))
        if not math.isfinite(em+ee) or em>1e-4 or ee>100:raise ValueError('CMT conservation gate failed')
    def record(t,ss,flows):
        check_balance(ss)
        trace.append(dict(t_s=float(t),primaryPressure_MPa=ss[0]['ptop']/1e6,primary_C=ss[0]['rows'][0]['T']-273.15,
            tanks=[dict(layers_C=[r['T']-273.15 for r in ss[k]['rows'][1:]],
                # Reference leg is externally conditioned at the declared cold
                # temperature; its density follows current pressure, whereas
                # the calibration density remains the initial value.
                rawLevelDP_Pa=g*(sum(r['rho']*6/N for r in ss[k]['rows'][1:])-water(ss[k]['ptop'],cold)[0]*6),
                rawSourceDP_Pa=2000*flows[j]*abs(flows[j])/25**2*rc/ss[k]['rows'][-1]['rho'],
                actualSourceFlow_kg_s=flows[j],delivered_kg=delivered[j]) for j,k in enumerate([1,3])]))
    record(0.,initial,[0.,0.]);old=initial;t=0.;nextout=b['output_s']
    while t<b['duration_s']-1e-9:
        dt=min(maxstep,b['duration_s']-t,nextout-t)
        opening=min(1.,(t+dt)/2.)*(.5 if stuck else 1.)
        def residual(xx):
            ss=unpack(xx[:physical]*scale);q=xx[physical:]*25
            rm=[(s['M']-o['M'])/dt for s,o in zip(ss,old)]
            re=[(s['E']-o['E'])/dt for s,o in zip(ss,old)]
            hydraulic=[]
            def connect(a,ia,bb,ib,m):
                donor=ss[a]['rows'][ia] if m>=0 else ss[bb]['rows'][ib]
                H=donor['h']+g*donor['z']
                rm[a][ia]+=m;rm[bb][ib]-=m
                re[a][ia]+=m*H;re[bb][ib]-=m*H
            def loss(m,p1,z1,r1,p2,z2,r2,K,check=False):
                rho=r1 if m>=0 else r2
                demand=p1-p2+.5*(r1+r2)*g*(z1-z2)
                defect=(K*m*abs(m)*rc/rho-demand+(1000 if check else 0))/20000
                if check:
                    a=m/25
                    return math.sqrt(a*a+defect*defect)-a-defect
                return defect
            for train,(ti,di) in enumerate([(1,2),(3,4)]):
                tank=ss[ti];main=ss[0];d=ss[di];qi,qo,qd=q[3*train:3*train+3]
                connect(0,0,ti,0,qi);connect(ti,-1,di,0,qo);connect(di,0,0,0,qd)
                hydraulic.append(qi/25 if blocked and train==0 else loss(qi,main['ptop'],3.,main['rows'][0]['rho'],tank['ptop'],12.,tank['rows'][0]['rho'],2000/25**2*rh/rc))
                hydraulic.append(loss(qo,tank['pbottom'],6.,tank['rows'][-1]['rho'],d['ptop'],3.,d['rows'][0]['rho'],20000/25**2/opening**2,True))
                hydraulic.append(loss(qd,d['ptop'],3.,d['rows'][0]['rho'],main['ptop'],3.,main['rows'][0]['rho'],10000/100**2))
                for j in range(N):connect(ti,j,ti,j+1,q[6+train*N+j])
                for j in range(1,N):
                    # G is specified across a 1.5 m layer-center separation.
                    # Preserve the same effective conductivity when refining.
                    Q=b['interlayerConductance_W_K']*(N/4)*(tank['rows'][j]['T']-tank['rows'][j+1]['T'])
                    re[ti][j]+=Q;re[ti][j+1]-=Q
            return np.concatenate([np.concatenate(rm)/25,np.concatenate(re)/25e6,hydraulic])
        solved=root(residual,x,method='hybr',options=dict(xtol=min(tol,1e-11)))
        defect=max(abs(residual(solved.x)));nfev+=solved.nfev;maxdefect=max(maxdefect,defect)
        if not solved.success or not np.all(np.isfinite(solved.x)) or not math.isfinite(defect) or defect>1e-7:raise ValueError(f'CMT implicit step failed at {t}: {solved.message}; residual {defect}')
        x=solved.x;old=unpack(x[:physical]*scale);flows=x[physical+np.array([1,4])]*25
        check_balance(old)
        delivered+=dt*flows;t+=dt
        if t>=nextout-1e-9 or t>=b['duration_s']-1e-9:
            record(t,old,flows);nextout+=b['output_s']
    return dict(name=name,layers=N,nfev=nfev,maxScaledResidual=maxdefect,maxMassResidual_kg=em,maxEnergyResidual_J=ee,trace=trace)

# Thermodynamic Jacobian check against independent perturbations, not only a
# conserved numerical trajectory that might share the same derivative mistake.
p=b['initialPressure_MPa']*1e6;T=b['cold_C']+273.15;w=water(p,T)
derivativeChecks=[]
for name,index,delta,variable in [('rho_p',3,100.,0),('rho_T',4,.001,1),('u_p',5,100.,0),('u_T',6,.001,1)]:
    pa,ta=(p+delta,T) if variable==0 else (p,T+delta)
    pb,tb=(p-delta,T) if variable==0 else (p,T-delta)
    prop=0 if name.startswith('rho') else 1
    fd=(water(pa,ta)[prop]-water(pb,tb)[prop])/(2*delta)
    error=abs(fd-w[index])/max(abs(w[index]),1e-15)
    if error>1e-5:raise ValueError('IF97 derivative identity failed: '+name)
    derivativeChecks.append(dict(name=name,relativeError=error))
cases=[run('healthy',b['layers'],b['relativeTolerance'],b['maximumStep_s']),
       run('blocked_balance_A',b['layers'],b['relativeTolerance'],b['maximumStep_s'],blocked=True),
       run('one_outlet_stuck_per_train',b['layers'],b['relativeTolerance'],b['maximumStep_s'],stuck=True),
       run('half_step',b['layers'],b['relativeTolerance']/10,b['maximumStep_s']/2),
       run('double_layers',b['layers']*2,b['relativeTolerance'],b['maximumStep_s']),
       run('quadruple_layers',b['layers']*4,b['relativeTolerance'],b['maximumStep_s'])]
`
export const cmtObservationCalculation = String.raw`def observation(case,loss=False):
    trace=case['trace'];rc=water(b['initialPressure_MPa']*1e6,b['cold_C']+273.15)[0]
    level=trace[0]['tanks'][0]['rawLevelDP_Pa'];dp=0.;previous=trace[0];rows=[]
    uncertain=0.
    for row in trace:
        t=row['t_s'];dt=t-previous['t_s'];a=row['tanks'][0];prev=previous['tanks'][0]
        powered=not(loss and 20<=t<40)
        previously_powered=not(loss and 20<=previous['t_s']<40)
        if previously_powered:
            for key,tau in [('level',1.),('flow',.25)]:
                old=prev['rawLevelDP_Pa' if key=='level' else 'rawSourceDP_Pa']
                new=a['rawLevelDP_Pa' if key=='level' else 'rawSourceDP_Pa']
                value=level if key=='level' else dp
                e=math.exp(-dt/tau)
                value=value*e+old*(1-e)+(new-old)*(1-tau/dt*(1-e)) if dt else value
                if key=='level':level=value
                else:dp=value
        acquired=powered and (t==0 or previously_powered)
        if acquired:
            # Worst positive permitted zero bias challenges a false delivery.
            reported=math.floor((dp+5)/.5+.5)*.5
            if abs(reported)>8000:raise ValueError('CMT source DP exceeded selected measurement range')
            lower=math.copysign(25*math.sqrt(abs(reported-5.25)/2000),reported-5.25)
            upper=math.copysign(25*math.sqrt(abs(reported+5.25)/2000),reported+5.25)
            positive=lower>3
            observed_dt=max(0.,t-max(previous['t_s'],3.)) if previously_powered else 0.
            uncertain=uncertain+observed_dt if not positive and t>=3 else 0.
            # This light replay advises only; it never issues a plant action.
            assessment='delivery_evidence_not_established' if uncertain>=3 else 'positive_delivery_evidence' if positive else 'qualifying'
            indicated=6+level/(g*rc);range_state='ABOVE_RANGE' if indicated>6 else 'BELOW_RANGE' if indicated<0 else 'IN_RANGE'
            level_report=math.floor(min(6.,max(0.,indicated))/.01+.5)*.01
            rows.append(dict(t_s=t,quality='AVAILABLE',apparentLevel_m=level_report,levelRange=range_state,rawSourceDP_Pa=reported,
                liquidCalibrationInterval_kg_s=[lower,upper],assessment=assessment))
        else:
            uncertain=0.
            rows.append(dict(t_s=t,quality='UNAVAILABLE',reason='REACQUIRING' if powered else 'I_UNPOWERED',apparentLevel_m=None,levelRange=None,rawSourceDP_Pa=None,
                liquidCalibrationInterval_kg_s=None,assessment='cannot_assess_delivery'))
        previous=row
    return dict(case=case['name'],instrumentPowerInterruption=loss,trace=rows)
`
const cmtReviewCalculation = String.raw`def compare(a,bb):
    return dict(maxPressureDifference_MPa=max(abs(x['primaryPressure_MPa']-y['primaryPressure_MPa']) for x,y in zip(a['trace'],bb['trace'])),
       maxMatchedLayerBandDifference_C=max(float(max(abs(np.array(x['tanks'][0]['layers_C'])-np.array(y['tanks'][0]['layers_C']).reshape(len(x['tanks'][0]['layers_C']),-1).mean(axis=1)))) for x,y in zip(a['trace'],bb['trace'])),
       finalDeliveryDifference_kg=abs(a['trace'][-1]['tanks'][0]['delivered_kg']-bb['trace'][-1]['tanks'][0]['delivered_kg']))
refinement=dict(time=compare(cases[0],cases[3]),layers=compare(cases[0],cases[4]),finerLayers=compare(cases[4],cases[5]))
replays=[observation(cases[0]),observation(cases[1]),observation(cases[0],True)]
time_screen=bool(refinement['time']['maxPressureDifference_MPa']<.01 and
    refinement['time']['maxMatchedLayerBandDifference_C']<.05 and refinement['time']['finalDeliveryDifference_kg']<2.)
# Diagnostic screens chosen after exploratory runs, not plant qualification.
if not time_screen:raise ValueError('CMT temporal numerical screen failed')
projection_comparisons=[]
for case in [cases[3],cases[4],cases[5]]:
    alternate=observation(case)
    changes=sum(a['assessment']!=bb['assessment'] for a,bb in zip(replays[0]['trace'],alternate['trace']) if a['t_s']>=6)
    level_difference=max(abs(a['apparentLevel_m']-bb['apparentLevel_m']) for a,bb in zip(replays[0]['trace'],alternate['trace']))
    if changes or level_difference>.011:raise ValueError('CMT measured delivery comparison changed under refinement')
    projection_comparisons.append(dict(case=case['name'],postQualificationAssessmentDifferences=changes,
        maxReportedLevelDifference_m=level_difference))
if replays[0]['trace'][-1]['assessment']!='positive_delivery_evidence':raise ValueError('Healthy delivery evidence was not established')
if replays[1]['trace'][-1]['assessment']!='delivery_evidence_not_established':raise ValueError('Blocked-balance evidence incorrectly established delivery')
if replays[1]['trace'][-1]['apparentLevel_m']<5.9:raise ValueError('Blocked-balance case lost its full-looking tank comparison')
if any(r['quality']!='UNAVAILABLE' or r['rawSourceDP_Pa'] is not None for r in replays[2]['trace'] if 20<=r['t_s']<40):
    raise ValueError('Unpowered instrument leaked current evidence')
if next(r for r in replays[2]['trace'] if r['t_s']==40)['quality']!='UNAVAILABLE':raise ValueError('Restoration republished held state as fresh evidence')
print(json.dumps(dict(versions=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),
    derivativeChecks=derivativeChecks,cases=cases,refinement=refinement,
    temporalDiagnosticScreenPassed=time_screen,highAccuracyPressureFrontQualified=False,
    observationRefinement=projection_comparisons,observationReplays=replays)))
`
export const cmtCalculation = cmtLiquidDefinitions + cmtRunCalculation + cmtObservationCalculation + cmtReviewCalculation

/** Exact semidiscrete upwind comparison, not a tank thermocline/temperature model. */
export function cmtTracerDiagnostic(input:{height_m:number;area_m2:number;velocity_m_s:number;duration_s:number;cells:number;probeDepth_m:number}) {
  const {height_m:H,area_m2:A,velocity_m_s:v,duration_s:t,cells:N,probeDepth_m:probe}=input
  if(![H,A,v,t,probe].every(Number.isFinite)||H<=0||A<=0||v<=0||t<=0||!Number.isInteger(N)||N<1||N>256||probe<0||probe>=H)
    throw new Error('Invalid bounded advection diagnostic input')
  const dz=H/N,lambda=v/dz,x=lambda*t
  if(x>20)throw new Error('This short-front diagnostic admits cell travel numbers up to 20')
  // P(Poisson(x)>=n), summing the positive tail avoids subtracting two nearly
  // equal numbers in initially remote cells. No timestep integration is used.
  const tail=(n:number)=>{
    let logFactorial=0
    for(let k=2;k<=n;k++)logFactorial+=Math.log(k)
    let term=Math.exp(-x+n*Math.log(x)-logFactorial),sum=term
    for(let k=n;k<1024;k++){
      term*=x/(k+1);sum+=term
      if(k>x&&term<=Math.max(sum,Number.MIN_VALUE)*1e-16)return sum
    }
    throw new Error('Poisson tail summation did not converge')
  }
  const front=v*t
  const exact=Array.from({length:N},(_,i)=>Math.min(1,Math.max(0,(front-i*dz)/dz)))
  const upwind=Array.from({length:N},(_,i)=>tail(i+1))
  const stored=A*dz*upwind.reduce((a,b)=>a+b,0)
  // Integral of the Nth-cell step response; independently accounts outlet flux.
  const exported=A*v*(t*tail(N)-N/lambda*tail(N+1))
  const incoming=A*v*t,residual=stored+exported-incoming
  if(!Number.isFinite(residual)||exported< -1e-12||Math.abs(residual)>1e-10*Math.max(1,incoming))
    throw new Error('Analytic advection conservation check failed')
  const l1=A*dz*upwind.reduce((sum,c,i)=>sum+Math.abs(c-exact[i]!),0)
  const ahead=A*upwind.reduce((sum,c,i)=>sum+c*Math.max(0,(i+1)*dz-Math.max(front,i*dz)),0)
  const reconstructionError=(values:number[])=>A*values.reduce((sum,c,i)=>{
    const behind=Math.min(dz,Math.max(0,front-i*dz))
    return sum+behind*Math.abs(1-c)+(dz-behind)*Math.abs(c)
  },0)
  const deeper=Math.min(N-1,Math.floor(probe/dz)),boundary=Math.abs(probe/dz-Math.round(probe/dz))<1e-10&&probe>0
  const neighbors=boundary?[deeper-1,deeper]:[deeper]
  return {input,cellHeight_m:dz,frontDepth_m:front,exactCellAverages:exact,semidiscreteUpwindCellAverages:upwind,
    incomingTracerVolume_m3:incoming,storedTracerVolume_m3:stored,exportedTracerVolume_m3:exported,conservationResidual_m3:residual,
    exactStoredTracerVolume_m3:A*Math.min(front,H),exactExportedTracerVolume_m3:A*Math.max(0,front-H),
    cellAverageL1Difference_m3:l1,aheadOfFrontUnderPiecewiseConstantReconstruction_m3:ahead,
    upwindReconstructionL1AgainstExactPointField_m3:reconstructionError(upwind),
    exactCellAverageReconstructionL1AgainstExactPointField_m3:reconstructionError(exact),
    leadingSpatialNumericalDiffusivity_m2_s:v*dz/2,
    probe:{depth_m:probe,exactPointValue:probe<front?1:0,atCellBoundary:boundary,
      neighboringCells:neighbors,exactNeighborCellAverages:neighbors.map(i=>exact[i]),upwindNeighborCellAverages:neighbors.map(i=>upwind[i]),
      deeperCellReconstructedValue:upwind[deeper],reconstruction:'Piecewise constant cell average; deeper cell chosen at an interface, not resolved point truth'}}
}

if(import.meta.main) {
  const [page,python]=process.argv.slice(2)
  if(!page||!python)throw new Error('Usage: reference-design-cmt.ts <wiki-page> <python>')
  const basis=parseCmtBasis(await Bun.file(page).text())
  const child=Bun.spawn([python,'-c',cmtCalculation],{stdin:new Blob([JSON.stringify(basis)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw new Error(stderr)
  console.log(JSON.stringify({input:basis,inputHash:createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    calculationHash:createHash('sha256').update(cmtCalculation).digest('hex'),...JSON.parse(stdout)},null,2))
}

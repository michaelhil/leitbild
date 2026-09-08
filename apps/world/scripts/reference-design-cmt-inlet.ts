/** Retained slot screen and signed radial-aperture/finite-receipt experiment; no entrainment law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cmtStratificationDefinitions, parseStratificationBasis } from './reference-design-cmt-stratification.ts'

const positive = z.number().finite().positive()
const schema = z.object({ pipeDiameter_m: positive, slotRadius_m: positive, slotGap_m: positive,
  slotElevation_m: z.number().finite(), tankTop_m: positive, tankArea_m2: positive,
  topProbeElevation_m: z.number().finite(), referenceFlow_kg_s: positive,
  totalReferenceLoss_Pa: positive, exitLossCoefficient: positive }).strict().superRefine((x,c) => {
  if (x.slotElevation_m+x.slotGap_m/2>=x.tankTop_m || x.slotElevation_m-x.slotGap_m/2<=x.topProbeElevation_m ||
    x.slotRadius_m>=Math.sqrt(x.tankArea_m2/Math.PI)) c.addIssue({code:'custom',message:'Inlet/probe geometry does not fit the tank'})
})
export function parseInletBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-inlet\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-inlet numeric block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export function inletScales(flow:number,inletDensity:number,receiverDensity:number,area:number,length:number) {
  if (![flow,inletDensity,receiverDensity,area,length].every(Number.isFinite) ||
    Math.min(inletDensity,receiverDensity,area,length)<=0) throw new Error('Invalid inlet scale state')
  const velocity=flow/(inletDensity*area), gravity=9.80665*(receiverDensity-inletDensity)/receiverDensity
  return { velocity_m_s:velocity, reducedGravity_m_s2:gravity,
    buoyancy:gravity>0?'lighter_inlet':gravity<0?'denser_inlet':'density_matched',
    direction:flow>0?'inflow':flow<0?'outflow':'zero_flow',
    dynamicHead_Pa:.5*inletDensity*velocity**2,
    signedRichardson:velocity===0?null:gravity*length/velocity**2,
    densimetricFroude:gravity===0?null:Math.abs(velocity)/Math.sqrt(Math.abs(gravity)*length),
    inertialBuoyancyLength_m:gravity===0?null:velocity**2/Math.abs(gravity) }
}
export function allocateLoss(density:number,flow:number,area:number,zeta:number,total:number) {
  if (![density,flow,area,zeta,total].every(Number.isFinite) || Math.min(density,flow,area,zeta,total)<=0)
    throw new Error('Invalid loss allocation')
  const exit=zeta*flow**2/(2*density*area**2)
  if(exit>=total)throw new Error('Selected exit leaves no positive feed-line loss budget')
  return { referenceDensity_kg_m3:density, exitReferenceLoss_Pa:exit, remainingLineReferenceLoss_Pa:total-exit }
}

export const inletCalculation=cmtStratificationDefinitions+String.raw`
cases=[study(name,nt,b['maximumStep_s'],True) for name,nt in [('limited',b['topCells']),('limited_double_top',2*b['topCells'])]]
print(json.dumps(dict(cases=cases,referenceDensity_kg_m3=water(b['initialPressure_MPa']*1e6,b['hot_C']+273.15)[0])))
`

const apertureSchema=z.object({holeDiameter_m:positive,ringElevations_m:z.tuple([positive,positive,positive]),
  holesPerRing:z.literal(10),coefficient:positive.max(1),pressure_MPa:positive.min(5).max(20),
  duration_s:positive.max(1),steps_s:z.tuple([positive,positive]),massResidual_kg:positive,energyResidual_J:positive,
  entropyTolerance_J_K:positive,temperatureDifference_K:positive,pressureDifference_Pa:positive,relativeGrossFlowDifference:positive}).strict()
export function parseApertureBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-apertures\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-apertures numeric block')
  const b=apertureSchema.parse(JSON.parse(blocks[0]![1]!))
  if(b.steps_s[1]!==b.steps_s[0]/2 || b.ringElevations_m.some(z=>z+b.holeDiameter_m/2>=11.975||z-b.holeDiameter_m/2<=11.725))
    throw new Error('Apertures must fit actual body; steps must halve')
  if([...b.steps_s,.01].some(dt=>Math.abs(b.duration_s/dt-Math.round(b.duration_s/dt))>1e-8) ||
    b.steps_s.some(dt=>Math.abs(.01/dt-Math.round(.01/dt))>1e-8))throw new Error('Duration and output must align with actual accepted steps')
  return b
}

export const apertureDefinitions=String.raw`
import json,sys,math,time
import numpy as np
from scipy.optimize import root,brentq
from numpy.polynomial.legendre import leggauss
from iapws.iapws97 import _Region1,_PSat_T
b=json.load(sys.stdin);g=9.80665;radius=b['holeDiameter_m']/2
bodyArea=math.pi*.35**2/4;bodyVolume=bodyArea*.25;headerVolume=.05-bodyVolume
nodes,weights=leggauss(8)
headNodes,headWeights=leggauss(3)

def water(p,T):
    if not .1e6<p<30e6 or not 273.15<T<623.15 or p<=_PSat_T(T)*1e6:raise ValueError('Aperture rig outside liquid domain')
    r=_Region1(T,p/1e6);v=r['v'];h=r['h']*1000;s=r['s']*1000
    return dict(rho=1/v,h=h,u=h-p*v,mu=h-T*s,s=s)

def pressure(p,T,z,datum=12.):
    # Exact isothermal hydrostatics: chemical potential + gz is constant.
    base=water(p,T);target=g*(datum-z);q=p+base['rho']*target
    for _ in range(6):
        # Integrate dmu=v dp directly, avoiding subtraction of large chemical potentials.
        delta=q-p;integral=delta/2*sum(w*_Region1(T,(p+delta*(x+1)/2)/1e6)['v'] for x,w in zip(headNodes,headWeights))
        w=water(q,T);error=integral-target
        if abs(error)<1e-9:return q
        q-=error*w['rho']
    raise ValueError('Hydrostatic chemical-potential inversion failed')

def vessel(p,T,kind):
    # Actual body area/height plus header inventory, not .05m3 spread over tank area.
    za,zb,area=(11.725,11.975,bodyArea) if kind=='plenum' else (6.,12.,10.)
    mass=energy=entropy=0.
    for x,w in zip(nodes,weights):
        z=(za+zb)/2+(zb-za)*x/2;dv=area*(zb-za)*w/2;r=water(pressure(p,T,z),T)
        mass+=dv*r['rho'];energy+=dv*r['rho']*(r['u']+g*z);entropy+=dv*r['rho']*r['s']
    if kind=='plenum':
        r=water(p,T);mass+=headerVolume*r['rho'];energy+=headerVolume*r['rho']*(r['u']+g*12);entropy+=headerVolume*r['rho']*r['s']
    return dict(mass=mass,energy=energy,entropy=entropy,p=p,T=T)

def tank_at(pt,upperT,lowerT,interface,z):
    if upperT==lowerT:return pressure(pt,upperT,z),upperT
    if z>=interface:return pressure(pt,upperT,z),upperT
    pi=pressure(pt,upperT,interface)
    return pressure(pi,lowerT,z,interface),lowerT

def aperture_flux(pp,Tp,pt,Tu,Tl,interface,cd,n=16):
    nn,ww=leggauss(n);rings=[]
    for center in b['ringElevations_m']:
        def states(z):
            p1=pressure(pp,Tp,z);p2,T2=tank_at(pt,Tu,Tl,interface,z)
            return p1,p2,T2
        def dp(z):
            p1,p2,_=states(z);return p1-p2
        cuts=[center-radius,center+radius]
        if Tu!=Tl and cuts[0]<interface<cuts[-1]:cuts.append(interface)
        cuts.sort();extra=[]
        for lo,hi in zip(cuts[:-1],cuts[1:]):
            if dp(lo)*dp(hi)<0:extra.append(brentq(dp,lo,hi,xtol=1e-12))
        cuts=sorted(cuts+extra);q=heat=grossOut=grossIn=dissipation=areaSum=0.
        for lo,hi in zip(cuts[:-1],cuts[1:]):
            aa=math.asin(max(-1.,min(1.,(lo-center)/radius)));bb=math.asin(max(-1.,min(1.,(hi-center)/radius)))
            # One smooth map on EVERY interval: no head-threshold quadrature branch.
            for node,weight in zip(nn,ww):
                t=(node+1)/2;wt=weight/2
                theta=aa+(bb-aa)*math.sin(math.pi*t/2)**2
                jac=(bb-aa)*math.pi/2*math.sin(math.pi*t)
                z=center+radius*math.sin(theta);da=2*radius**2*math.cos(theta)**2*jac*wt*b['holesPerRing']
                p1,p2,T2=states(z);delta=p1-p2;donor=water(p1,Tp) if delta>=0 else water(p2,T2)
                dq=cd*da*math.copysign(math.sqrt(2*donor['rho']*abs(delta)),delta)
                q+=dq;heat+=dq*(donor['h']+g*z);grossOut+=max(dq,0);grossIn+=max(-dq,0)
                dissipation+=dq/donor['rho']*delta;areaSum+=da
        if dissipation < -1e-10:raise ValueError('Negative hydraulic dissipation')
        rings.append(dict(elevation_m=center,flow_kg_s=q,outflow_kg_s=grossOut,inflow_kg_s=grossIn,
            energyToTank_W=heat,dissipation_W=dissipation,area_m2=areaSum))
    return dict(rings=rings,net=sum(r['flow_kg_s'] for r in rings),energy=sum(r['energyToTank_W'] for r in rings),
        outflow=sum(r['outflow_kg_s'] for r in rings),inflow=sum(r['inflow_kg_s'] for r in rings))

def balanced_initial(Tp,Tt,cd):
    pt=b['pressure_MPa']*1e6
    pp=brentq(lambda pp:aperture_flux(pp,Tp,pt,Tt,Tt,11.85,cd)['net'],pt-2000,pt+2000,xtol=1e-5)
    return np.array([pp,Tp,pt,Tt])

def receipt_step(y,old,dt,iteration_tolerance=1e-10):
    scales=np.array([1e7,500,1e7,500])
    def residual(x):
        p1,t1,p2,t2=x*scales;new=[vessel(p1,t1,'plenum'),vessel(p2,t2,'tank')]
        f=aperture_flux(p1,t1,p2,t2,t2,11.85,b['coefficient']);dm=dt*f['net'];de=dt*f['energy']
        return np.array([new[0]['mass']-old[0]['mass']+dm,new[1]['mass']-old[1]['mass']-dm,
            (new[0]['energy']-old[0]['energy']+de)/1e6,(new[1]['energy']-old[1]['energy']-de)/1e6])
    sol=root(residual,y/scales,method='hybr',options=dict(xtol=iteration_tolerance))
    return sol,residual(sol.x)

def run(name,Tp,Tt,dt):
    started=time.perf_counter();y=balanced_initial(Tp,Tt,b['coefficient']);old=[vessel(y[0],y[1],'plenum'),vessel(y[2],y[3],'tank')]
    M0=sum(x['mass'] for x in old);E0=sum(x['energy'] for x in old);S0=sum(x['entropy'] for x in old)
    scales=np.array([1e7,500,1e7,500]);trace=[];maxM=maxE=maxR=0.;t=0.;received=returned=0.;previousS=S0;minimumDS=float('inf')
    def record():
        f=aperture_flux(*y, y[3],11.85,b['coefficient'])
        trace.append(dict(t_s=t,plenumPressure_Pa=y[0],plenum_C=y[1]-273.15,tankPressure_Pa=y[2],tank_C=y[3]-273.15,
            net_kg_s=f['net'],outflow_kg_s=f['outflow'],inflow_kg_s=f['inflow'],rings=f['rings'],
            receivedMass_kg=received,returnedMass_kg=returned))
    record()
    for k in range(round(b['duration_s']/dt)):
        sol,rr=receipt_step(y,old,dt)
        if not np.all(np.isfinite(sol.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1e-7:
            print(json.dumps(dict(name=name,status='REJECTED_NONLINEAR_RESIDUAL',dt=dt,time_s=(k+1)*dt,nfev=sol.nfev,residual=rr.tolist())),file=sys.stderr,flush=True)
            return dict(name=name,status='REJECTED_NONLINEAR_RESIDUAL',step_s=dt,attemptedTime_s=(k+1)*dt,
                residual=rr.tolist(),solverMessage=str(sol.message),maxMassResidual_kg=maxM,maxEnergyResidual_J=maxE,
                nfev=sol.nfev,lastAcceptedState=y.tolist(),trialState=(sol.x*scales).tolist(),
                maxScaledResidual=maxR,trace=trace,wall_s=time.perf_counter()-started)
        y=sol.x*scales;old=[vessel(y[0],y[1],'plenum'),vessel(y[2],y[3],'tank')]
        f=aperture_flux(y[0],y[1],y[2],y[3],y[3],11.85,b['coefficient'])
        received+=dt*f['outflow'];returned+=dt*f['inflow'];t=(k+1)*dt
        maxM=max(maxM,abs(sum(x['mass'] for x in old)-M0));maxE=max(maxE,abs(sum(x['energy'] for x in old)-E0));maxR=max(maxR,float(max(abs(rr))))
        currentS=sum(x['entropy'] for x in old);minimumDS=min(minimumDS,currentS-previousS);previousS=currentS
        if maxM>b['massResidual_kg'] or maxE>b['energyResidual_J']:raise ValueError('Finite source/receiver ledger rejected')
        if minimumDS < -b['entropyTolerance_J_K']:raise ValueError('Finite receipt entropy decreased')
        if abs(t/.01-round(t/.01))<1e-8:record()
    quadrature=[]
    for row in [trace[0],trace[-1]]:
        p1,t1,p2,t2=row['plenumPressure_Pa'],row['plenum_C']+273.15,row['tankPressure_Pa'],row['tank_C']+273.15
        fine=aperture_flux(p1,t1,p2,t2,t2,11.85,b['coefficient'],32)
        errors={key:max(abs(a[key]-c[key]) for a,c in zip(row['rings'],fine['rings'])) for key in ['flow_kg_s','outflow_kg_s','inflow_kg_s']}
        if max(errors.values())>.001:raise ValueError('Gross counterflow quadrature rejected')
        quadrature.append(dict(time_s=row['t_s'],maximumRingDifferences=errors))
    print(json.dumps(dict(name=name,status='COMPLETED',dt=dt,time_s=t)),file=sys.stderr,flush=True)
    return dict(name=name,status='COMPLETED',step_s=dt,maxMassResidual_kg=maxM,maxEnergyResidual_J=maxE,maxScaledResidual=maxR,
        totalEntropyChange_J_K=sum(x['entropy'] for x in old)-S0,minimumEntropyIncrement_J_K=minimumDS,
        counterflowQuadrature=quadrature,trace=trace,wall_s=time.perf_counter()-started)

`
export const apertureCalculation=apertureDefinitions+String.raw`

# Static stratification tests do not receive energy or claim thermal evolution.
static=[];pt=b['pressure_MPa']*1e6
for zi in [12.,11.925,11.85,11.775,11.7]:
    pp=brentq(lambda p:aperture_flux(p,563.15,pt,563.15,313.15,zi,b['coefficient'])['net']-25,pt-2000,pt+2000,xtol=1e-5)
    a=aperture_flux(pp,563.15,pt,563.15,313.15,zi,b['coefficient']);c=aperture_flux(pp,563.15,pt,563.15,313.15,zi,b['coefficient'],32)
    err=max(abs(x['flow_kg_s']-y['flow_kg_s']) for x,y in zip(a['rings'],c['rings']))
    if err>.001:raise ValueError('Aperture quadrature rejection')
    static.append(dict(interfaceElevation_m=zi,plenumTopPressureOffset_Pa=pp-pt,flux=a,quadratureMaxRingDifference_kg_s=err))
same=aperture_flux(pt,313.15,pt,313.15,313.15,11.85,b['coefficient'])
if same['net']!=0 or same['outflow']!=0 or same['inflow']!=0:raise ValueError('Identical hydrostatic states flow')
for r in same['rings']:
    if abs(r['area_m2']-10*math.pi*radius**2)>1e-10:raise ValueError('Circular aperture area identity')
rho=water(pt,563.15)['rho'];area=30*math.pi*radius**2
allocations=[dict(coefficient=cd,holeLoss_Pa=(25/(cd*area))**2/(2*rho),lineLoss_Pa=2000-(25/(cd*area))**2/(2*rho)) for cd in [.6,b['coefficient'],.8]]
if any(x['lineLoss_Pa']<=0 for x in allocations):raise ValueError('No positive line loss remains')
cases=[run(name,tp,tt,dt) for name,tp,tt in [('hot_plenum',563.15,313.15),('cool_plenum',313.15,563.15)] for dt in b['steps_s']]
comparisons=[]
for a,c in [(cases[0],cases[1]),(cases[2],cases[3])]:
    if a['status']!='COMPLETED' or c['status']!='COMPLETED':
        comparisons.append(dict(name=a['name'],passed=False,reason='At least one finite trajectory rejected before duration'))
        continue
    if [r['t_s'] for r in a['trace']]!=[r['t_s'] for r in c['trace']]:raise ValueError('Receipt refinement time mismatch')
    dT=max(abs(x['plenum_C']-y['plenum_C']) for x,y in zip(a['trace'],c['trace']));dp=max(abs(x['tankPressure_Pa']-y['tankPressure_Pa']) for x,y in zip(a['trace'],c['trace']))
    dq=max(abs(x['outflow_kg_s']-y['outflow_kg_s']) for x,y in zip(a['trace'],c['trace']))/max(y['outflow_kg_s'] for y in c['trace'])
    passed=bool(dT<=b['temperatureDifference_K'] and dp<=b['pressureDifference_Pa'] and dq<=b['relativeGrossFlowDifference'])
    comparisons.append(dict(name=a['name'],maximumPlenumTemperatureDifference_K=dT,maximumTankPressureDifference_Pa=dp,relativeGrossFlowDifference=dq,passed=passed))
print(json.dumps(dict(scope='Actual signed radial-aperture transfer; separate finite well-mixed thermal apparatus, no stratification evolution',
    allocations=allocations,static=static,identicalState=same,cases=cases,comparisons=comparisons,
    hydraulicReceiptReferenceAccepted=all(c['passed'] for c in comparisons),physicalTankRedistributionQualified=False)))
`
type Row={t_s:number;balanceToTankFlow_kg_s:number;balanceDensity_kg_m3:number;topCellDensity_kg_m3:number;
  tankInletMass_kg:number;inletStateVolume_m3:number|null;[key:string]:unknown}
const added=['balanceToTankFlow_kg_s','balanceDensity_kg_m3','topCellDensity_kg_m3','tankInletMass_kg','inletStateVolume_m3']
export function oldTraceProjection(trace:Row[]) {
  return trace.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!added.includes(key))))
}
if(import.meta.main) {
  if(process.argv[2]==='--apertures') {
    const [,page,python]=process.argv.slice(2)
    if(!page||!python)throw new Error('Usage: reference-design-cmt-inlet.ts --apertures <wiki-page> <python>')
    const input=parseApertureBasis(await Bun.file(page).text())
    const child=Bun.spawn([python,'-c',apertureCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'inherit'})
    const [stdout,status]=await Promise.all([new Response(child.stdout).text(),child.exited])
    if(status!==0)throw new Error('Aperture calculation failed; see diagnostic stderr')
    console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      calculationHash:createHash('sha256').update(apertureCalculation).digest('hex'),...JSON.parse(stdout)},null,2))
    process.exit(0)
  }
  const [page,python,retainedPath]=process.argv.slice(2)
  if(!page||!python||!retainedPath)throw new Error('Usage: reference-design-cmt-inlet.ts <wiki-page> <python> <retained-calorimetry-json>')
  const document=await Bun.file(page).text(), input=parseStratificationBasis(document), geometry=parseInletBasis(document)
  const retainedText=await Bun.file(retainedPath).text(),retained=JSON.parse(retainedText)
  if(retained.calculationHash!=='22e1b49f0fd5804024756848b13c553f029e0cb4ddb0842b39e20b31d12ba617')
    throw new Error('Expected the retained, independently reviewed calorimetry source')
  const child=Bun.spawn([python,'-c',inletCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(stderr)
  const result=JSON.parse(stdout),slotArea=2*Math.PI*geometry.slotRadius_m*geometry.slotGap_m
  const pipeArea=Math.PI*geometry.pipeDiameter_m**2/4
  const cases=result.cases.map((run:{name:string;trace:Row[];finalSnapshot:{area_m2:number;topElevation_m:number}})=>{
    const old=retained.cases.find((c:{name:string})=>c.name===run.name)?.sourceRun
    if(!old||JSON.stringify(oldTraceProjection(run.trace))!==JSON.stringify(old.trace))throw new Error('Historical trace changed')
    if(geometry.tankArea_m2!==run.finalSnapshot.area_m2 || geometry.tankTop_m!==run.finalSnapshot.topElevation_m)
      throw new Error('Screen geometry differs from actual source tank')
    const screen=run.trace.map(row=>({t_s:row.t_s,
      slotAgainstTopCell:inletScales(row.balanceToTankFlow_kg_s,row.balanceDensity_kg_m3,row.topCellDensity_kg_m3,slotArea,geometry.slotGap_m),
      barePipeAgainstTopCell:inletScales(row.balanceToTankFlow_kg_s,row.balanceDensity_kg_m3,row.topCellDensity_kg_m3,pipeArea,geometry.pipeDiameter_m)}))
    const last=run.trace.at(-1)!
    // Existing BAL volume is exactly 1 m3. Main-to-BAL and BAL-to-tank
    // integrals must differ by its actual stored mass change.
    const balanceMassResidual=last.tankInletMass_kg-Number(last.grossInlet_kg)-
      (run.trace[0]!.balanceDensity_kg_m3-last.balanceDensity_kg_m3)
    if(Math.abs(balanceMassResidual)>1e-5)throw new Error('Actual tank inlet integral violates finite BAL mass balance')
    return {name:run.name,historicalTraceExactlyEqual:true,balanceMassResidual_kg:balanceMassResidual,run,screen,
      finalInletStateVolume_m3:last.inletStateVolume_m3,
      equivalentVolumeDepth_m:last.inletStateVolume_m3===null?null:last.inletStateVolume_m3/geometry.tankArea_m2,
      slotToProbe_m:geometry.slotElevation_m-geometry.topProbeElevation_m}
  })
  console.log(JSON.stringify({scope:'New inlet geometry screened over unchanged old apparatus states, not hardware-coupled dynamics',input,geometry,
    postprocessorSourceHash:createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex'),
    inputHash:createHash('sha256').update(JSON.stringify({input,geometry})).digest('hex'),
    calculationHash:createHash('sha256').update(inletCalculation).digest('hex'),
    retainedArtifactHash:createHash('sha256').update(retainedText).digest('hex'),
    areas_m2:{slot:slotArea,barePipe:pipeArea},
    allocation:allocateLoss(result.referenceDensity_kg_m3,geometry.referenceFlow_kg_s,slotArea,geometry.exitLossCoefficient,geometry.totalReferenceLoss_Pa),
    cases,pressureFrontQualified:false,physicalEntrainmentSelected:false},null,2))
}

/** Offline radial energy experiments with explicit mechanical/receiving boundaries, not a live Plant Model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fuelMaterialPython, fuelGeometryPython } from './reference-design-fuel-materials.ts'
import { fuelGeometry, parseFuelConstruction } from './reference-design-fuel-construction.ts'
const inputSchema=z.object({fuelIntervals:z.tuple([z.literal(8),z.literal(16),z.literal(32)]),
  maxSteps_s:z.tuple([z.literal(.2),z.literal(.1),z.literal(.05)]),
  hold_s:z.literal(2),reducedPowerFraction:z.literal(.9),reducedDuration_s:z.literal(20),recovery_s:z.literal(20)}).strict()
export function parseFuelTransient(doc:string){
  const blocks=[...doc.matchAll(/^```reference-fuel-transient\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-fuel-transient block')
  return inputSchema.parse(JSON.parse(blocks[0]![1]!))
}
/** Existing finite radial material equations, reusable by the circuit experiment. */
export const radialReferencePython=String.raw`
import sys,json,math,platform
import numpy as np,scipy,iapws
from scipy.integrate import quad,solve_ivp
from scipy.optimize import root,brentq,newton
from functools import lru_cache
from iapws import IAPWS97 as W
from iapws.iapws97 import _Region1
b=d['basis']; case=d['case']; geom=d['geometry']; old=d['reference']; rows=old['base']['rows']; boundary=old['actualBoundary']; pi=math.pi; N=geom['rods']; checks=[]
finite=d['experiment']=='finite-coolant';moving=d['experiment']!='fixed';b={**b,'coolantPressures_MPa':boundary['coolantPressures_MPa']}
${fuelMaterialPython}
def check(name,a,e,atol):
    if not math.isfinite(a) or abs(a-e)>atol:raise ValueError(f'{name}: {a} != {e}, allowance {atol}')
    checks.append(dict(name=name,actual=a,expected=e,allowance=atol))
ro0=b['rodOuterDiameter_m']/2;ri0=ro0-b['cladThickness_m']; rf0=b['pelletDiameter_m']/2; L0=b['activeLength_m']/2;relocation=.3*(ri0-rf0)
${fuelGeometryPython}
vp=pi*ri0**2*b['plenumLength_m']; tp=boundary['coolantTemperatures_K'][-1]+10
nR=b['fillPressure_Pa']*(vp+pi*(ri0**2-rf0**2)*b['activeLength_m'])/300
G=boundary['massflow_kg_s']/geom['flowArea_m2']; dh=geom['hydraulicDiameter_m']
saturation=[W(P=p,x=0).T for p in boundary['coolantPressures_MPa'][1:]]
@lru_cache(maxsize=256)
def film(j,tw,tb=None,flow=None,externalPressure_MPa=None):
    tb=boundary['coolantTemperatures_K'][j+1] if tb is None else tb
    p=boundary['coolantPressures_MPa'][j+1] if externalPressure_MPa is None else externalPressure_MPa
    flux=G if flow is None else flow/geom['flowArea_m2']
    w=W(P=p,T=(tb+tw)/2);re=flux*dh/w.mu;pr=w.cp*1000*w.mu/w.k
    limit=saturation[j] if externalPressure_MPa is None else W(P=p,x=0).T
    if re<10000 or not .6<pr<160 or tw>=limit:raise ValueError('Outside liquid turbulent boundary')
    return .023*re**.8*pr**.4*w.k/dh
volume=geom['coreFlowVolume_m3']/2
@lru_cache(maxsize=256)
def water(j,temp):
    if not math.isfinite(temp) or temp<548.15 or temp>=min(601.15,saturation[j]):raise ValueError('Receiver outside selected compressed-liquid range')
    p=boundary['coolantPressures_MPa'][j+1];w=_Region1(temp,p);rho=1/w['v'];mass=rho*volume
    return dict(M=mass,U=mass*(w['h']*1000-p*1e6*w['v']),h=w['h']*1000,
        cp=w['cp']*1000,dMdT=-mass*w['alfav'],flowWork=p*1e6*w['v'])
inlet=W(P=boundary['coolantPressures_MPa'][0],T=boundary['coolantTemperatures_K'][0])
inletH=inlet.h*1000;inletFlowWork=boundary['coolantPressures_MPa'][0]*1e6/inlet.rho
def steadyCoolant(factor):
    enthalpy=inletH;temps=[]
    for j,r in enumerate(rows):
        enthalpy+=r['power_W']*factor/boundary['massflow_kg_s']
        temps.append(W(P=boundary['coolantPressures_MPa'][j+1],h=enthalpy/1000).T)
    return temps
def continuum(factor):
    # Independent conductivity-integral steady challenge, not the FV residual.
    coolant=steadyCoolant(factor) if finite else boundary['coolantTemperatures_K'][1:]
    def residual(v):
        pg=v[-1]*1e6; out=[]; inv=vp/tp
        for j,r in enumerate(rows):
            tw,ti,tf,tc=v[4*j:4*j+4]
            geo=geometry((tw,ti,tf,tc),pg,j) if moving else (r['fuelRadius_m'],r['cladInnerRadius_m'],r['cladOuterRadius_m'],r['activeLength_m'],0,0,r['thermallyExpandedSolidRadius_m'])
            rf,ri,ro,L,_,_,solidRf=geo
            qp=r['power_W']*factor/N/L;p=boundary['coolantPressures_MPa'][j+1];tb=coolant[j]
            h=film(j,tw,tb)
            qg=gap((tw,ti,tf,tc),pg,geo,0.)[0]
            out.extend([(2*pi*ro*h*(tw-tb)-qp)/qp,(ck(ti)-ck(tw)-qp*math.log(ro/ri)/(2*pi))/qp,
                (qg*2*pi*rf-qp)/qp,(fk(tc)-fk(tf)-qp/(4*pi))/qp])
            inv+=pi*(ri*ri-rf*rf)*L/((tf+ti)/2)+pi*(rf*rf-solidRf*solidRf)*L/fuelAreaMean(tf,tc)
        return out+[(pg*inv-nR)/nR]
    guess=[v for r in rows for v in [r['Tw_K'],r['TcladInner_K'],r['TfuelSurface_K'],r['TfuelCenter_K']]]+[old['base']['heliumPressure_Pa']/1e6]
    solved=root(residual,guess,tol=1e-10)
    if not solved.success:raise ValueError(solved.message)
    check('independent continuum residual '+str(factor),max(abs(x) for x in residual(solved.x)),0,1e-8)
    projection=[]
    for j,r in enumerate(rows):
        tw,ti,tf,tc=solved.x[4*j:4*j+4]
        geo=geometry((tw,ti,tf,tc),solved.x[-1]*1e6,j) if moving else (r['fuelRadius_m'],r['cladInnerRadius_m'],r['cladOuterRadius_m'],r['activeLength_m'],0,0,r['thermallyExpandedSolidRadius_m'])
        _,ri,ro,L,*_=geo;qp=r['power_W']*factor/N/L
        def ft(x):return brentq(lambda t:fk(t)-fk(tf)-qp/(4*pi)*(1-x*x),tf-1e-7,tc+1e-7)
        def ct(x):
            radius=math.sqrt(ri*ri+x*(ro*ro-ri*ri))
            return brentq(lambda t:ck(t)-ck(tw)-qp/(2*pi)*math.log(ro/radius),tw-1e-7,ti+1e-7)
        ef=r['fuelMass_kg']*quad(lambda x:2*x*(hf(ft(x))-hf(300)),0,1,epsabs=1e-5)[0]
        ec=r['cladMass_kg']*quad(lambda x:hc(ct(x)),0,1,epsabs=1e-5)[0]
        record=dict(center_K=float(tc),surface_K=float(tf),wall_K=float(tw),mean_K=fuelAreaMean(tf,tc),solidEnergy_J=ef+ec)
        if finite:record['coolant_K']=coolant[j]
        projection.append(record)
    return projection
def make(n,circuit=False):
    nc=n//4; segments=[]; initial=[]
    for j,r in enumerate(rows):
        rf=r['fuelRadius_m'];ri=r['cladInnerRadius_m'];ro=r['cladOuterRadius_m'];L=r['activeLength_m']
        fr=np.linspace(0,rf,n+1);cr=np.linspace(ri,ro,nc+1)
        ff=np.r_[0,(fr[:-1]+fr[1:])/2,rf];cf=np.r_[ri,(cr[:-1]+cr[1:])/2,ro]
        fw=np.diff(ff**2)/rf**2;cw=np.diff(cf**2)/(ro**2-ri**2)
        offset=len(initial);fi=slice(offset,offset+n+1);ci=slice(offset+n+1,offset+n+nc+2)
        qp=r['linePower_W_m']; tf=r['TfuelSurface_K'];tc=r['TfuelCenter_K'];tw=r['Tw_K'];ti=r['TcladInner_K']
        initial.extend(brentq(lambda t:fk(t)-fk(tf)-qp/(4*pi)*(1-(x/rf)**2),tf-1e-7,tc+1e-7) for x in fr)
        initial.extend(brentq(lambda t:ck(t)-ck(tw)-qp/(2*pi)*math.log(ro/x),tw-1e-7,ti+1e-7) for x in cr)
        segments.append(dict(j=j,fi=fi,ci=ci,fw=fw,cw=cw,mf=fw*r['fuelMass_kg']/N,mc=cw*r['cladMass_kg']/N,
            fuelNodeFraction=fr/rf,fuelFaceFraction=ff[1:-1]/rf,
            cladNodeArea=(cr*cr-ri*ri)/(ro*ro-ri*ri),cladFaceArea=(cf[1:-1]**2-ri*ri)/(ro*ro-ri*ri),
            gf=2*pi*L*ff[1:-1]/np.diff(fr),gc=2*pi*L*cf[1:-1]/np.diff(cr),r=r,
            vg=pi*(ri*ri-rf*rf)*L,vc=r['effectiveCrackGasVolumePerRod_m3'],
            geo=(rf,ri,ro,L,r['cladElasticDisplacement_um']*1e-6,r['hoopStress_MPa']*1e6,r['thermallyExpandedSolidRadius_m']),
            power=r['power_W']/N,p=boundary['coolantPressures_MPa'][j+1],tb=boundary['coolantTemperatures_K'][j+1]))
    solidSize=len(initial)
    if finite:initial.extend(boundary['coolantTemperatures_K'][1:])
    initial=np.array(initial); size=len(initial)
    def geometricState(t,pg,current=None):
        values=[]
        for s in segments:
            f=t[s['fi']];c=t[s['ci']]
            po=None if current is None else current['p_MPa'][s['j']]
            geo=geometry((c[-1],c[0],f[-1],f[0]),pg,s['j'],externalPressure_MPa=po) if moving else s['geo']
            rf,ri,ro,L,_,_,solidRf=geo
            if ri-rf<=0 or ri-solidRf-.5*relocation<=0:raise ValueError('Outside retained BOL noncontact geometry')
            values.append((geo,pi*(ri*ri-rf*rf)*L,pi*(rf*rf-solidRf*solidRf)*L))
        return values
    def inventory(t,pg,current=None):
        inv=vp/tp
        for s,(_,vg,vc) in zip(segments,geometricState(t,pg,current)):
            f=t[s['fi']];c=t[s['ci']];inv+=vg/((f[-1]+c[0])/2)+vc/float(s['fw']@f)
        return inv
    def pressure(t,current=None):
        if not moving:return nR/inventory(t,old['base']['heliumPressure_Pa'])
        pg=float(newton(lambda p:p*inventory(t,p,current)-nR,old['base']['heliumPressure_Pa'],tol=1e-5))
        if not math.isfinite(pg) or pg<=0:raise ValueError('Sealed gas pressure is not finite and positive')
        residual=pg*inventory(t,pg,current)-nR
        if not math.isfinite(residual) or abs(residual)>1e-9:raise ValueError('Sealed gas closure did not converge')
        return pg
    def balances(t,factor,current=None):
        if current is not None and finite:raise ValueError('Circuit owns water; finite receiver must be absent')
        pg=pressure(t,current); rates=np.zeros(size); caps=np.zeros(size); out=[]; gaps=[];fluid=[]
        massIn=boundary['massflow_kg_s'];hIn=inletH
        for s,(geo,_,_) in zip(segments,geometricState(t,pg,current)):
            f=t[s['fi']];c=t[s['ci']];r=s['r']
            if min(f)<500 or max(f)>2000 or min(c)<300 or max(c)>1000:raise ValueError('Material temperature outside selected reference')
            rf,ri,ro,L,*_=geo
            if moving:
                fr=s['fuelNodeFraction']*rf;ff=s['fuelFaceFraction']*rf
                cr=np.sqrt(ri*ri+s['cladNodeArea']*(ro*ro-ri*ri));cf=np.sqrt(ri*ri+s['cladFaceArea']*(ro*ro-ri*ri))
                gf=2*pi*L*ff/np.diff(fr);gc=2*pi*L*cf/np.diff(cr)
            else:gf=s['gf'];gc=s['gc']
            qf=gf*np.diff(-np.array([fk(x) for x in f]));qc=gc*np.diff(-np.array([ck(x) for x in c]))
            qg=gap((c[-1],c[0],f[-1],f[0]),pg,geo,0.)[0]*2*pi*rf*L
            tb=t[solidSize+s['j']] if finite else s['tb']
            po=None;flow=massIn if finite else None
            if current is not None:
                tb=current['T_K'][s['j']];po=current['p_MPa'][s['j']];flow=current['flow_kg_s'][s['j']]
            hfC=film(s['j'],c[-1],tb,flow,po)
            qo=hfC*(c[-1]-tb)*2*pi*ro*L
            rates[s['fi']]=s['power']*factor*s['fw']+np.r_[0,qf]-np.r_[qf,qg]
            rates[s['ci']]=np.r_[qg,qc]-np.r_[qc,qo]
            caps[s['fi']]=s['mf']*np.array([cpf(x) for x in f]);caps[s['ci']]=s['mc']*np.array([cpc(x) for x in c])
            out.append(qo);gaps.append(qg)
            if finite:
                w=water(s['j'],tb);net=massIn*(hIn-w['h'])+qo*N;capacity=w['M']*w['cp']
                td=net/capacity;massOut=massIn-w['dMdT']*td
                if not math.isfinite(massOut) or massOut<=0:raise ValueError('Receiver outside declared positive serial-flow branch')
                rates[solidSize+s['j']]=net/N;caps[solidSize+s['j']]=capacity/N
                fluid.append(dict(**w,T_K=float(tb),inflow_kg_s=massIn,outflow_kg_s=massOut,
                    netU_W=massIn*hIn-massOut*w['h']+qo*N,dM_kg_s=massIn-massOut,
                    incomingEnthalpy_W=massIn*hIn,outgoingEnthalpy_W=massOut*w['h']))
                massIn=massOut;hIn=w['h']
        return rates,caps,sum(out),out,gaps,fluid
    def fluidStored(t):
        states=[water(j,t[solidSize+j]) for j in range(2)] if finite else []
        return sum(w['U'] for w in states),sum(w['M'] for w in states)
    def nodeEnergy(t):
        values=np.zeros(solidSize)
        for s in segments:
            values[s['fi']]=s['mf']*np.array([hf(x)-hf(300) for x in t[s['fi']]])
            values[s['ci']]=s['mc']*np.array([hc(x) for x in t[s['ci']]])
        return values
    def energy(t):
        return sum(float(s['mf']@np.array([hf(x)-hf(300) for x in t[s['fi']]]))+float(s['mc']@np.array([hc(x) for x in t[s['ci']]])) for s in segments)
    def mechanical(t,current=None):
        pg=pressure(t,current);volumes=[];vg=vp;elastic=0.
        for s,(geo,gapVolume,crackVolume) in zip(segments,geometricState(t,pg,current)):
            rf,ri,ro,L,_,hoop,_=geo;vg+=gapVolume+crackVolume;volumes.append(pi*ro*ro*L)
            c=t[s['ci']];tm=(c[0]+c[-1])/2;E=1.088e11-5.475e7*tm;Gz=4.04e10-2.168e7*tm;nu=E/(2*Gz)-1
            if E<=0 or Gz<=0:raise ValueError('Elastic property domain exceeded')
            po=s['p'] if current is None else current['p_MPa'][s['j']]
            axial=(ri0**2*pg-ro0**2*po*1e6)/(ro0**2-ri0**2)
            # Consistent with the already selected leading-order cold-radius plane stress model.
            elastic+=(hoop*hoop+axial*axial-2*nu*hoop*axial)/(2*E)*sum(s['mc'])/b['cladDensity_kg_m3']
        return dict(pg=pg,outer=np.array(volumes),gasVolume=vg,gasEnergy=1.5*pg*vg,elastic=elastic)
    if circuit:
        if finite or not moving:raise ValueError('Circuit experiment requires quasistatic solids without a coolant owner')
        return dict(initial=initial,balances=balances,nodeEnergy=nodeEnergy,energy=energy,
            mechanical=mechanical,segments=segments,solidSize=solidSize)
    def equilibrium(factor,guess):
        solution=root(lambda t:balances(t,factor)[0]/1000,guess,tol=1e-10)
        if not solution.success:raise ValueError(solution.message)
        check('discrete steady residual '+str(n)+' '+str(factor),max(abs(balances(solution.x,factor)[0])),0,1e-5)
        return solution.x
    nominal=equilibrium(1,initial);reduced=equilibrium(case['reducedPowerFraction'],nominal)
    check('finite shell masses '+str(n),sum(sum(s['mf'])+sum(s['mc']) for s in segments)*N,geom['fuelMass_kg']+geom['cladMass_kg'],1e-7)
    def projection(t):return [dict(center_K=float(t[s['fi']][0]),surface_K=float(t[s['fi']][-1]),wall_K=float(t[s['ci']][-1]),mean_K=float(s['fw']@t[s['fi']]),
        **({'coolant_K':float(t[solidSize+s['j']])} if finite else {})) for s in segments]
    continuumEnergy=sum(r['fuelSensibleEnergy_J']+r['cladSensibleEnergy_J'] for r in rows)
    def run(step,pulse=True):
        t=nominal.copy();e0=energy(t);pg0=pressure(t); clock=0.; ledger=0.; fluidLedger=0.;massLedger=0.;output=[];maxError=0.;maxFluidError=0.;maxMassError=0.;gasRatios=[];events=[];prior=1.;acceptedSteps=0;actualMaxStep=0.
        fluidU0,fluidM0=fluidStored(t)
        initialMechanical=mechanical(t);lastMechanical=initialMechanical;externalWork=0.;absoluteExternal=0.;internalGasWork=0.;absoluteGasChange=0.;absoluteElasticChange=0.;mechanicalRatios=[]
        phases=[(case['hold_s'],1.)]+([(case['reducedDuration_s'],case['reducedPowerFraction']),(case['recovery_s'],1.)] if pulse else [])
        for duration,factor in phases:
            if factor!=prior:
                before=balances(t,prior);after=balances(t,factor)
                check('event changes source not boundary heat '+str(n)+' '+str(clock),before[2],after[2],1e-9)
                events.append(dict(time_s=clock,fromFraction=prior,toFraction=factor,temperatureReset=False,projection=projection(t)))
            prior=factor
            y0=np.r_[t,ledger,fluidLedger,massLedger] if finite else np.r_[t,ledger]
            def rhs(tm,y):
                rates,caps,qo,_,_,fluid=balances(y[:size],factor)
                tail=[sum(s['power'] for s in segments)*factor-qo]
                if finite:tail.extend([sum(w['netU_W'] for w in fluid)/N,sum(w['dM_kg_s'] for w in fluid)/N])
                return np.r_[rates/caps,tail]
            result=solve_ivp(rhs,(0,duration),y0,method='BDF',rtol=1e-9,atol=1e-9,max_step=step,dense_output=True)
            if not result.success:raise ValueError(result.message)
            acceptedSteps+=len(result.t)-1;actualMaxStep=max(actualMaxStep,float(max(np.diff(result.t))))
            sampleTimes=sorted(set([min(1.,duration),min(5.,duration),duration]));mechanicalSamples={}
            if moving:
                for tm in sorted(set(result.t[1:].tolist()+sampleTimes)):
                    current=mechanical(result.sol(tm)[:size]);dv=current['outer']-lastMechanical['outer']
                    works=np.array([s['p']*1e6 for s in segments])*dv
                    externalWork+=sum(works);absoluteExternal+=sum(abs(works))
                    internalGasWork+=(current['pg']+lastMechanical['pg'])/2*(current['gasVolume']-lastMechanical['gasVolume'])
                    absoluteGasChange+=abs(current['gasEnergy']-lastMechanical['gasEnergy']);absoluteElasticChange+=abs(current['elastic']-lastMechanical['elastic'])
                    lastMechanical=current
                    if tm in sampleTimes:mechanicalSamples[tm]=dict(externalWork_J=externalWork*N,
                        internalGasWork_J=internalGasWork*N,gasEnergyChange_J=(current['gasEnergy']-initialMechanical['gasEnergy'])*N,
                        elasticEnergyChange_J=(current['elastic']-initialMechanical['elastic'])*N,
                        accumulatedAbsoluteOmitted_J=(absoluteExternal+absoluteGasChange+absoluteElasticChange)*N)
            for elapsed in sampleTimes:
                y=result.sol(elapsed);tt=y[:size];en=energy(tt);error=(en-e0-y[size])*N;maxError=max(maxError,abs(error))
                gasDelta=(mechanical(tt)['gasEnergy']-initialMechanical['gasEnergy'])*N
                solidDelta=(en-e0)*N
                rates,_,qo,out,gaps,fluid=balances(tt,factor)
                check('paired interface cancellation '+str(n)+' '+str(clock+elapsed),float(sum(rates[:solidSize])),sum(s['power'] for s in segments)*factor-qo,1e-7)
                receiver=None
                if finite:
                    uf,mf=fluidStored(tt);fluidError=uf-fluidU0-y[size+1]*N;massError=mf-fluidM0-y[size+2]*N
                    maxFluidError=max(maxFluidError,abs(fluidError));maxMassError=max(maxMassError,abs(massError))
                    check('serial donor enthalpy cancellation '+str(n)+' '+str(clock+elapsed),fluid[0]['outgoingEnthalpy_W'],fluid[1]['incomingEnthalpy_W'],1e-7)
                    check('serial donor mass cancellation '+str(n)+' '+str(clock+elapsed),fluid[0]['outflow_kg_s'],fluid[1]['inflow_kg_s'],1e-9)
                    pressureWork=boundary['massflow_kg_s']*inletFlowWork-fluid[-1]['outflow_kg_s']*fluid[-1]['flowWork']
                    netEnthalpy=boundary['massflow_kg_s']*inletH-fluid[-1]['outgoingEnthalpy_W']
                    internalAdvection=boundary['massflow_kg_s']*(inletH-inletFlowWork)-fluid[-1]['outflow_kg_s']*(fluid[-1]['h']-fluid[-1]['flowWork'])
                    check('donor enthalpy includes pressure flow work '+str(n)+' '+str(clock+elapsed),netEnthalpy,internalAdvection+pressureWork,1e-4)
                    receiver=dict(cells=fluid,internalEnergyChange_J=uf-fluidU0,massChange_kg=mf-fluidM0,
                        energyResidual_J=fluidError,massResidual_kg=massError,totalSolidFluidResidual_J=error+fluidError,
                        netPortFlowWork_W=pressureWork,netInternalEnergyAdvection_W=internalAdvection,netEnthalpyFlow_W=netEnthalpy)
                if clock+elapsed>case['hold_s'] and abs(solidDelta)>1.:gasRatios.append(abs(gasDelta/solidDelta))
                if moving and clock+elapsed>case['hold_s'] and abs(solidDelta)>1.:
                    mm=mechanicalSamples[elapsed]
                    mechanicalRatios.append((abs(mm['externalWork_J'])+abs(mm['gasEnergyChange_J'])+abs(mm['elasticEnergyChange_J']))/abs(solidDelta))
                output.append(dict(time_s=clock+elapsed,sourceFraction=factor,projection=projection(tt),solidEnergyChange_J=solidDelta,
                    netBoundaryEnergy_J=float(y[size])*N,energyResidual_J=error,omittedGasEnergyChange_J=gasDelta,heliumPressure_Pa=pressure(tt),receiver=receiver,
                    heatToCoolant_W=[x*N for x in out],gapHeat_W=[x*N for x in gaps],mechanicalOmission=mechanicalSamples.get(elapsed),
                    thermalGaps_um=[(g[0][1]-g[0][0])*1e6 for g in geometricState(tt,pressure(tt))]))
            t=result.y[:size,-1];ledger=result.y[size,-1]
            if finite:fluidLedger=result.y[size+1,-1];massLedger=result.y[size+2,-1]
            clock+=duration
        pulseEnergy=sum(s['power'] for s in segments)*N*(1-case['reducedPowerFraction'])*case['reducedDuration_s']
        check('solid caloric ledger '+str(n)+' '+str(step),maxError,0,1e-6*pulseEnergy)
        if finite:
            check('native coolant internal energy ledger '+str(n)+' '+str(step),maxFluidError,0,1e-6*pulseEnergy)
            check('native coolant mass ledger '+str(n)+' '+str(step),maxMassError,0,1e-5)
        maxGasRatio=max(gasRatios) if gasRatios else 0.
        if maxGasRatio>=.001:raise ValueError('Gas omission exceeds 0.1 percent of sampled actual solid energy change')
        gasPulseRatio=max(abs(x['omittedGasEnergyChange_J']) for x in output)/pulseEnergy
        if gasPulseRatio>=.001:raise ValueError('Gas omission exceeds 0.1 percent of imposed pulse energy')
        mechanicalRatio=max(mechanicalRatios) if mechanicalRatios else 0.
        accumulated=(absoluteExternal+absoluteGasChange+absoluteElasticChange)*N
        peakSolid=max(abs(x['solidEnergyChange_J']) for x in output)
        if moving and pulse and (mechanicalRatio>=.001 or accumulated/pulseEnergy>=.001 or accumulated/peakSolid>=.001):
            raise ValueError('Mechanical/gas omission exceeds declared 0.1 percent energy scales')
        return dict(maxStep_s=step,acceptedSteps=acceptedSteps,actualMaximumStep_s=actualMaxStep,pulse=pulse,samples=output,events=events,maximumEnergyResidual_J=maxError,maximumGasToSolidChangeRatio=maxGasRatio,
            maximumGasToPulseEnergyRatio=gasPulseRatio,maximumMechanicalToActualSolidChangeRatio=mechanicalRatio,
            accumulatedAbsoluteOmitted_J=accumulated,omissionToPulseRatio=accumulated/pulseEnergy,
            omissionToPeakSolidRatio=accumulated/peakSolid if pulse else None,
            maximumCoolantEnergyResidual_J=maxFluidError,maximumCoolantMassResidual_kg=maxMassError)
    return dict(intervals=n,cladIntervals=nc,nominal=projection(nominal),reducedSteady=projection(reduced),
        continuumInitialProjection=projection(initial),initialEnergyDifference_J=energy(nominal)*N-continuumEnergy,
        initialReceiver=dict(volumePerCell_m3=volume,cells=balances(nominal,1)[-1]) if finite else None,
        nominalHeliumPressure_Pa=pressure(nominal),hold=run(.1,False),transients=[run(step) for step in (case['maxSteps_s'] if n==16 else [.05])])
`
const calculation=String.raw`
import json,sys
d=json.load(sys.stdin)
${radialReferencePython}
targets=dict(nominal=continuum(1.),reduced=continuum(case['reducedPowerFraction']))
results=[make(n) for n in case['fuelIntervals']]
def projdiff(a,b):return max(abs(x[k]-y[k]) for x,y in zip(a,b) for k in x)
space=[]
for a,b in zip(results,results[1:]):
    delta=max(projdiff(x['projection'],y['projection']) for x,y in zip(a['transients'][-1]['samples'],b['transients'][-1]['samples']))
    space.append(dict(coarse=a['intervals'],fine=b['intervals'],maximumProjectionDifference_K=delta))
temporal=[]
for a,b in zip(results[1]['transients'],results[1]['transients'][1:]):
    delta=max(projdiff(x['projection'],y['projection']) for x,y in zip(a['samples'],b['samples']))
    temporal.append(dict(coarse_s=a['maxStep_s'],fine_s=b['maxStep_s'],maximumProjectionDifference_K=delta))
check('finest spatial change',space[-1]['maximumProjectionDifference_K'],0,1.)
check('finest temporal change',temporal[-1]['maximumProjectionDifference_K'],0,.05)
for mode,target in targets.items():
    errors=[projdiff(r['nominal' if mode=='nominal' else 'reducedSteady'],target) for r in results]
    if not errors[2]<errors[1]<errors[0]:raise ValueError('Continuum target not approached under radial refinement')
    check('finest independent continuum '+mode,errors[-1],0,.1)
for r in results:check('nominal hold '+str(r['intervals']),projdiff(r['nominal'],r['hold']['samples'][-1]['projection']),0,1e-6)
print(json.dumps(dict(scope='quasistatic BOL radial solids coupled to finite pressure-supported serial liquid receivers; not a closed primary circuit' if finite else 'quasistatic BOL geometry with fixed material masses; gas/mechanical energy omissions screened' if moving else 'fixed achieved BOL geometry; conservative solid radial energy; gas capacity screened, not retained; prescribed liquid coolant',
    packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__,iapws=iapws.__version__),
    results=results,continuumTargets=targets,spatialRefinement=space,temporalRefinement=temporal,checks=checks,
    finitePressureSupportedReceiver=finite,quasistaticGeometry=moving,fullThermomechanicsQualified=False,gasEnergyRetained=False,empiricalFuelValidation=False,liveRuntime=False),allow_nan=False,indent=2))
`
export function resolveFuelTransientInput(fuelDoc:string,caseDoc:string,bolJson:string,experiment:'fixed'|'quasistatic'|'finite-coolant'='fixed'){
  z.enum(['fixed','quasistatic','finite-coolant']).parse(experiment)
  const basis=parseFuelConstruction(fuelDoc),input=parseFuelTransient(caseDoc),geometry=fuelGeometry(basis)
  const artifact=JSON.parse(bolJson),reference=artifact.relocated
  if(reference?.materialState!=='beginning-of-life'||!reference.actualBoundary)throw Error('Expected accepted connected BOL radial artifact')
  if(reference.base.rows.some((row:{power_W:number},j:number)=>Math.abs(row.power_W-reference.actualBoundary.cellHeat_W[j])>.05))throw Error('BOL source duty differs from connected initialization')
  if(reference.geometrySha256!==createHash('sha256').update(fuelGeometry.toString()).digest('hex'))throw Error('BOL geometry owner changed')
  const resolved={...basis,coolantPressures_MPa:reference.actualBoundary.coolantPressures_MPa,coolantTemperatures_K:reference.actualBoundary.coolantTemperatures_K}
  if(reference.inputSha256!==createHash('sha256').update(JSON.stringify(resolved)).digest('hex'))throw Error('BOL construction basis changed; rerun its owner')
  return {basis,case:input,geometry,reference,experiment}
}
export async function runFuelTransient(fuelDoc:string,caseDoc:string,bolJson:string,python:string,experiment:'fixed'|'quasistatic'|'finite-coolant'='fixed'){
  const data=resolveFuelTransientInput(fuelDoc,caseDoc,bolJson,experiment)
  const child=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify(data)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw Error(err||`Radial transient failed:${exit}`)
  return {calculationSha256:createHash('sha256').update(calculation).digest('hex'),
    inputSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    bolArtifactSha256:createHash('sha256').update(bolJson).digest('hex'),...JSON.parse(out)}
}
if(import.meta.main){
  const [fuel,doc,bol,python,mode,...extra]=Bun.argv.slice(2)
  if(!fuel||!doc||!bol||!python||extra.length)throw Error('Usage: bun reference-design-fuel-transient.ts <fuel.md> <transient.md> <BOL.json> <python> [fixed|quasistatic|finite-coolant]')
  const experiment=z.enum(['fixed','quasistatic','finite-coolant']).parse(mode??'fixed')
  console.log(JSON.stringify(await runFuelTransient(await Bun.file(fuel).text(),await Bun.file(doc).text(),await Bun.file(bol).text(),python,experiment),null,2))
}

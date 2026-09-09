/** Finite geometric return inertia on the existing CMT patch water; not a plume solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePatchBasis, patchDefinitions } from './reference-design-cmt-patches'

export const inertiaSchema = z.object({
  maximumDensityFraction: z.literal(.05), maximumNumericalHeatFraction: z.literal(.1),
  zeroDissipationEnergy_J: z.literal(1e-9), modalResidual_kg_s: z.literal(1e-7),
}).strict()

export function parseInertiaBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-inertia\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-inertia block')
  return { ...parsePatchBasis(document), inertia: inertiaSchema.parse(JSON.parse(blocks[0]![1]!)) }
}

export const inertiaDefinitions = patchDefinitions + String.raw`
from functools import lru_cache
from types import MappingProxyType
ib=b['inertia']
uncached_leggauss=leggauss

@lru_cache(maxsize=8)
def leggauss(n):
    xx,ww=uncached_leggauss(n);xx.flags.writeable=False;ww.flags.writeable=False
    return xx,ww

@lru_cache(maxsize=32768)
def isentrope(p,entropy,guess):
    T=guess
    for _ in range(5):
        w=water(p,T);r=_Region1(T,p/1e6);defect=w['s']-entropy
        if abs(defect)<2e-10:return MappingProxyType(w),T
        T-=defect*T/(1000*r['cp'])
    w=water(p,T)
    require(abs(w['s']-entropy)<2e-9,'Returned isentropic state residual')
    return MappingProxyType(w),T

def driving_enthalpy(pa,pb,donor,T,n=3):
    # dh=v dp at constant s; direct quadrature avoids subtracting large h at tiny head.
    # Both end states are independently phase-admitted even when flow opposes head.
    wa,Ta=isentrope(pa,donor['s'],T);wb,Tb=isentrope(pb,donor['s'],T)
    delta=pa-pb;xx,ww=leggauss(n)
    value=delta/2*sum(weight/isentrope(pb+delta*(node+1)/2,donor['s'],T)[0]['rho'] for node,weight in zip(xx,ww))
    return value,wa['h']-wb['h']

def inertia_geometry(geom):
    rc=2*(geom['r1']**3-geom['r0']**3)/(3*(geom['r1']**2-geom['r0']**2))
    rho=water(b['pressure_MPa']*1e6,s['initialResident_C']+273.15)['rho']
    return dict(centerRadius_m=rc,referenceDensity_kg_m3=rho,
      ownedWaterVolume_m3=math.pi*(geom['r1']**2-rc**2)*s['pitch_m'],
      inertiaPerArea=geom['r1']*math.log(geom['r1']/rc)/rho)

def mode_metric(geom):return np.array([geom['outerArea'],geom['outerArea']/3])
def kinetic(modes,geom,ig):return .5*ig['inertiaPerArea']*np.sum(modes*modes*mode_metric(geom),axis=-1)

def return_nodes(z,modes,geom,n):
    # Split at velocity zero, NOT pressure zero: inertial uphill flow is admitted.
    cuts=[-1.,1.]
    if modes[1]!=0 and -1.<-modes[0]/modes[1]<1.:cuts.insert(1,-modes[0]/modes[1])
    xx,ww=leggauss(n)
    for lo,hi in zip(cuts[:-1],cuts[1:]):
        for x,w in zip(xx,ww):
            xi=(lo+hi)/2+(hi-lo)*x/2;da=geom['outerArea']*(hi-lo)*w/4
            yield z+s['pitch_m']*xi/2,np.array([1.,xi]),da

def inertial_return(a,bb,z,modes,geom,ig,n=16):
    force=np.zeros(2);left=right=out=back=q=drive=loss=uphill=transfer=0.;density=0.
    for zz0,phi,da in return_nodes(z,modes,geom,n):
        j=float(phi@modes);pa,wa=at(a,zz0);pb,wb=at(bb,zz0)
        fromLeft=j>0 or (j==0 and pa>=pb)
        donor=wa if fromLeft else wb;T=a['T'] if fromLeft else bb['T']
        H,difference=driving_enthalpy(pa,pb,donor,T)
        ell=s['returnLoss']*j*abs(j)/(2*donor['rho']**2)
        force+=da*phi*(H-ell);dq=da*j;diss=da*j*ell
        if j>=0:
            take=dq*(wa['h']+g*zz0);give=take-dq*H+diss
            left-=take;right+=give
        else:
            take=-dq*(wb['h']+g*zz0);give=take-dq*H+diss
            right-=take;left+=give
        q+=dq;out+=max(dq,0);back+=max(-dq,0);drive+=dq*H;loss+=diss
        transfer+=abs(dq)*(donor['h']+g*zz0)
        if dq*(pa-pb)<0:uphill+=abs(dq)
        density=max(density,abs(wa['rho']/ig['referenceDensity_kg_m3']-1),abs(wb['rho']/ig['referenceDensity_kg_m3']-1))
    require(loss>=0,'Nonnegative physical return loss')
    require(abs((left+right)+(drive-loss))<1e-6,'Local return fluid/work identity')
    require(abs(float(modes@force)-(drive-loss))<1e-9,'Identical projected momentum/work quadrature')
    return dict(q=q,out=out,back=back,leftEnergy_W=left,rightEnergy_W=right,
      drivingPower_W=drive,dissipation_W=loss,absoluteAdvectivePower_W=transfer,
      uphillGross_kg_s=uphill,densityFraction=density,force=force)

def coupled_rates(profiles,modes,geom,ig,n=16):
    rates=np.zeros((5,2));ap=[];returns=[]
    for j,z in enumerate(zz):
        f=face(profiles[0],profiles[j+1],z-radius,z+radius,b['holesPerRing']*b['coefficient'],n,(z,radius))
        r=inertial_return(profiles[j+1],profiles[4],z,modes[j],geom,ig,n)
        rates[0]-=[f['q'],f['energy']];rates[j+1]+=[f['q']-r['q'],f['energy']+r['leftEnergy_W']]
        rates[4]+=[r['q'],r['rightEnergy_W']];ap.append(f);returns.append(r)
    for j in range(2):
        a=profiles[j+1];bb=profiles[j+2];wa=water(a['p'],a['T']);wb=water(bb['p'],bb['T'])
        ka=_ThCond(wa['rho'],a['T']);kb=_ThCond(wb['rho'],bb['T']);k=2*ka*kb/(ka+kb)
        heat=k*geom['area']/s['pitch_m']*(a['T']-bb['T']);rates[j+1,1]-=heat;rates[j+2,1]+=heat
    return rates,ap,returns

def initial_modes(profiles,geom):
    modes=[]
    for j,z in enumerate(zz):
        rhs=np.zeros(2);a=profiles[j+1];bb=profiles[4]
        # Project the historical sqrt-head field; not a new hydraulic equilibrium.
        lo=z-s['pitch_m']/2;hi=z+s['pitch_m']/2
        def head(zz0):return at(a,zz0)[0]-at(bb,zz0)[0]
        cuts=[lo,hi];dl=head(lo);dh=head(hi)
        if dl*dh<0:cuts.insert(1,lo+(hi-lo)*(-dl)/(dh-dl))
        nn,ww=leggauss(32)
        for lower,upper in zip(cuts[:-1],cuts[1:]):
            for node,weight in zip(nn,ww):
                t=(node+1)/2;zz0=lower+(upper-lower)*math.sin(math.pi*t/2)**2
                da=2*math.pi*geom['r1']*(upper-lower)*math.pi/2*math.sin(math.pi*t)*weight/2
                dp=head(zz0);donor=a if dp>=0 else bb;rho=at(donor,zz0)[1]['rho']
                j0=math.copysign(math.sqrt(2*rho*abs(dp)/s['returnLoss']),dp)
                rhs+=da*j0*np.array([1.,2*(zz0-z)/s['pitch_m']])
        modes.append(rhs/mode_metric(geom))
    return np.array(modes)

def primitive_checks():
    geom=geometry(1.);ig=inertia_geometry(geom);p=b['pressure_MPa']*1e6;rows=[]
    for T in [313.15,563.15]:
        donor=water(p,T)
        for head in [-1000.,-.001,0.,.001,1000.]:
            H,diff=driving_enthalpy(p+head,p,donor,T);tight,_=driving_enthalpy(p+head,p,donor,T,5)
            require(abs(H-tight)<1e-10,'Isentropic pressure-work quadrature')
            require(abs(H-diff)<2e-6,'Integral versus finite enthalpy difference')
            if head:require(H*head>0,'Weak-head sign preserved')
            rows.append(dict(T_K=T,head_Pa=head,integrated_J_kg=H,subtracted_J_kg=diff))
    # Independent analytic constant-I BE identity including numerical kinetic heat.
    old=np.array([20.,-35.]);new=np.array([-3.,18.]);dt=.002;G=mode_metric(geom);I=ig['inertiaPerArea']
    work=I*np.sum(new*G*(new-old))/dt;dK=(kinetic(new,geom,ig)-kinetic(old,geom,ig))/dt
    num=kinetic(new-old,geom,ig)/dt
    require(abs(work-dK-num)<1e-12,'Analytic BE kinetic-work identity')
    a=profile(p-10.,313.15);bb=profile(p,313.15)
    r=inertial_return(a,bb,zz[0],np.array([20.,0.]),geom,ig)
    require(r['q']>0 and r['uphillGross_kg_s']>0 and r['drivingPower_W']<0 and r['force'][0]<0,'Uphill flow decelerates, not sign-clamped')
    # Constant external-head primitive only; not a finite-source trajectory.
    j=20.;history=[];deltaH=driving_enthalpy(p-10.,p,water(p,313.15),313.15)[0]
    rho=water(p,313.15)['rho']
    for k in range(100):
        oldj=j
        j=brentq(lambda v:I*(v-oldj)/.01-deltaH+s['returnLoss']*v*abs(v)/(2*rho*rho),-1000.,1000.,xtol=1e-12)
        history.append(j)
    require(min(history)<0 and history[0]>0,'Finite deceleration crosses zero under reversed head')
    return dict(pressureWork=rows,kineticIdentityDefect_W=float(work-dK-num),uphillForce=r['force'].tolist(),
      fixedHeadReversal=dict(initial_kg_m2_s=20.,first_kg_m2_s=history[0],final_kg_m2_s=history[-1]),geometry=geom,inertia=ig)

def startup_linearization():
    from scipy.linalg import eig
    geom=geometry(1.);ig=inertia_geometry(geom);thermal=initial(geom)
    pp,Tc=decode(thermal);mm=initial_modes(pp,geom);x=np.r_[thermal,mm.ravel()/100]
    increments=np.r_[1e-7,np.full(4,1e-5),np.full(6,2e-7),np.full(6,1e-5)]
    def conserved_and_rate(trial):
        prof,cc=decode(trial[:11]);modes=trial[11:].reshape(3,2)*100
        inv=inventories(prof,geom);rates,aa,rr=coupled_rates(prof,modes,geom,ig)
        # Fixed row scales do not alter generalized eigenvalues. Modal scale is I_A*mass-flow tolerance.
        Y=np.r_[inv[:,0]/s['localMassTolerance_kg'],inv[:,1]/s['localEnergyTolerance_J'],
          s['calorimeterCapacity_J_K']*cc/s['localEnergyTolerance_J'],
          (mode_metric(geom)*modes/ib['modalResidual_kg_s']).ravel()]
        F=np.r_[rates[:,0]/s['localMassTolerance_kg'],rates[:,1]/s['localEnergyTolerance_J'],0.,
          (np.array([r['force'] for r in rr])/ig['inertiaPerArea']/ib['modalResidual_kg_s']).ravel()]
        return Y,F
    results=[]
    for factor in [1.,.5]:
        Ac=[];Bc=[]
        for k,h in enumerate(increments*factor):
            a=x.copy();bb=x.copy();a[k]+=h;bb[k]-=h
            ya,fa=conserved_and_rate(a);yb,fb=conserved_and_rate(bb)
            Ac.append((ya-yb)/(2*h));Bc.append((fa-fb)/(2*h))
        A=np.array(Ac).T;B=np.array(Bc).T
        # Scale unknowns by the declared physical probes and equilibrate equation rows once.
        A=A*increments;B=B*increments
        rowScale=np.maximum(np.linalg.norm(A,axis=1),1e-300);A=A/rowScale[:,None];B=B/rowScale[:,None]
        values,vectors=eig(B,A);require(np.all(np.isfinite(values)),'Finite generalized startup spectrum')
        residuals=[np.linalg.norm(B@v-lam*(A@v))/(np.linalg.norm(B)*np.linalg.norm(v)+abs(lam)*np.linalg.norm(A)*np.linalg.norm(v)) for lam,v in zip(values,vectors.T)]
        require(max(residuals)<1e-10,'Normalized generalized eigenpair residual')
        modes=[]
        for lam,res in sorted(zip(values,residuals),key=lambda pair:abs(pair[0]),reverse=True):
            modes.append(dict(real_per_s=float(lam.real),imaginary_per_s=float(lam.imag),
              inverseMagnitude_s=float(1/abs(lam)) if abs(lam)>1e-12 else None,normalizedResidual=float(res),
              backwardEulerMagnitude=[float(abs(1/(1-dt*lam))) for dt in s['steps_s']]))
        singular=np.linalg.svd(A,compute_uv=False)
        results.append(dict(probeFactor=factor,equilibratedStorageCondition=float(singular[0]/singular[-1]),
          minimumStorageSingularValue=float(singular[-1]),storageRank=int(np.linalg.matrix_rank(A)),modes=modes))
    # Nearest spectral distance is diagnostic, not an eigensolver-independent accuracy certificate.
    coarse=[complex(r['real_per_s'],r['imaginary_per_s']) for r in results[0]['modes']]
    fine=[complex(r['real_per_s'],r['imaginary_per_s']) for r in results[1]['modes']]
    fast=max(coarse,key=abs);distance=min(abs(fast-v) for v in fine)/abs(fast)
    return dict(scope='Frozen initial conserved-state rate Jacobian, not full trajectory stability or unique heat attribution',
      physicalProbes=dict(commonPressure_Pa=1.,head_Pa=.001,temperature_K=1e-4,mode_kg_m2_s=.001),
      fastestHalfProbeRelativeDistance=float(distance),evaluations=results)

def run_inertia(name,dt,duration,cooling=False,matched=False):
    started=time.perf_counter();geom=geometry(1.);ig=inertia_geometry(geom);thermal=initial(geom,matched)
    profiles,Tc=decode(thermal);modes=initial_modes(profiles,geom);x=np.r_[thermal,modes.ravel()/100]
    old=inventories(profiles,geom);K0=float(sum(kinetic(modes,geom,ig)));M0=sum(old[:,0])
    E0=sum(old[:,1])+s['calorimeterCapacity_J_K']*Tc+K0;S0=sum(old[:,2])+s['calorimeterCapacity_J_K']*math.log(Tc)
    oldRate,oldFlux=fluxes(profiles,geom);rate,ap,ret=coupled_rates(profiles,modes,geom,ig)
    initialization=dict(addedKineticEnergy_J=K0,addedFluidMass_kg=0.,nodeMassRates_kg_s=rate[:,0].tolist(),
      oldNodeMassRates_kg_s=oldRate[:,0].tolist(),returnProjection=[dict(old=rr,new={k:r[k] for k in ['q','out','back']}) for rr,r in zip(oldFlux['returns'],ret)])
    trace=[];maxM=maxE=maxLM=maxLE=maxModal=maxWork=0.;minDS=float('inf');prevS=S0;nfev=0
    gross=np.zeros(4);physical=numHeat=transfer=drive=0.;density=0.;halfAudit=None
    def record(t):
        _,aa,rr=coupled_rates(profiles,modes,geom,ig)
        trace.append(dict(t_s=t,topPressures_Pa=[w['p'] for w in profiles],temperatures_C=[w['T']-273.15 for w in profiles],
          calorimeter_C=Tc-273.15,modes_kg_m2_s=modes.tolist(),kineticEnergy_J=kinetic(modes,geom,ig).tolist(),
          grossIntegrated_kg=gross.tolist(),apertures=aa,returns=[{k:v for k,v in r.items() if k!='force'} for r in rr],
          physicalDissipation_J=physical,numericalKineticHeat_J=numHeat,absoluteAdvectiveEnergy_J=transfer))
    record(0.)
    steps=duration/dt;require(abs(steps-round(steps))<1e-9,'Exact duration clock')
    for step in range(round(steps)):
        acceptedX=x.copy();lastTrial=x.copy()
        enabled=cooling and step*dt>=s['coolingStart_s']-1e-12;oldTc=Tc;oldModes=modes.copy();oldK=kinetic(oldModes,geom,ig)
        def residual(trial):
            nonlocal lastTrial
            lastTrial=trial.copy()
            ww,cc=decode(trial[:11]);mm=trial[11:].reshape(3,2)*100;new=inventories(ww,geom)
            rates,aa,rr=coupled_rates(ww,mm,geom,ig);dn=kinetic(mm-oldModes,geom,ig)/dt
            rates[1:4,1]+=dn
            heat=s['coolingConductance_W_K']*(ww[0]['T']-cc) if enabled else 0.;rates[0,1]-=heat
            delta=new[:,:2]-old[:,:2]-dt*rates
            modal=ig['inertiaPerArea']*mode_metric(geom)*(mm-oldModes)/dt-np.array([r['force'] for r in rr])
            # Express integrated momentum residual as equivalent face mass-flow error.
            return np.r_[delta[:,0]/s['localMassTolerance_kg'],delta[:,1]/s['localEnergyTolerance_J'],
              (s['calorimeterCapacity_J_K']*(cc-oldTc)-dt*heat)/s['localEnergyTolerance_J'],
              (modal*dt/ig['inertiaPerArea']/ib['modalResidual_kg_s']).ravel()]
        increments=np.r_[1e-7,np.full(4,1e-5),np.full(6,2e-7),np.full(6,1e-5)]
        def jacobian(trial,factor=1.):
            columns=[]
            for k,h in enumerate(increments*factor):
                a=trial.copy();bb=trial.copy();a[k]+=h;bb[k]-=h
                columns.append((residual(a)-residual(bb))/(2*h))
            return np.array(columns).T
        try:
            sol=root(residual,x,jac=jacobian,options=dict(xtol=1e-12));rr=residual(sol.x)
        except ValueError as error:
            if str(error) not in ['Aperture rig outside liquid domain','Returned isentropic state residual']:raise
            return dict(name=name,status='REJECTED_PROPERTY_TRIAL',attemptedTime_s=(step+1)*dt,lastAcceptedTime_s=step*dt,
              lastAcceptedState=acceptedX.tolist(),trialState=lastTrial.tolist(),reason=str(error),trace=trace,initialization=initialization,wall_s=time.perf_counter()-started)
        nfev+=sol.nfev
        if not np.all(np.isfinite(sol.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1:
            return dict(name=name,status='REJECTED_LOCAL_RESIDUAL',attemptedTime_s=(step+1)*dt,lastAcceptedTime_s=step*dt,
              lastAcceptedState=x.tolist(),trialState=sol.x.tolist(),residualInToleranceUnits=rr.tolist(),nfev=sol.nfev,
              solverMessage=str(sol.message),trace=trace,initialization=initialization,wall_s=time.perf_counter()-started)
        if step==0:
            half=root(residual,x,jac=lambda a:jacobian(a,.5),options=dict(xtol=1e-12));hr=residual(half.x)
            aa,ac=decode(sol.x[:11]);bb,bc=decode(half.x[:11]);dp=max(abs(a['p']-b['p']) for a,b in zip(aa,bb));dT=max(abs(a['T']-b['T']) for a,b in zip(aa,bb));dj=max(abs(sol.x[11:]-half.x[11:]))*100
            require(max(abs(hr))<=1 and dp<.1 and dT<1e-6 and dj<1e-4,'Half physical Jacobian probes reach same admitted root')
            halfAudit=dict(pressure_Pa=dp,temperature_K=dT,modes_kg_m2_s=dj)
        x=sol.x;profiles,Tc=decode(x[:11]);modes=x[11:].reshape(3,2)*100;old=inventories(profiles,geom)
        rate,aa,rrr=coupled_rates(profiles,modes,geom,ig);newK=kinetic(modes,geom,ig);dn=kinetic(modes-oldModes,geom,ig)
        losses=np.array([r['dissipation_W'] for r in rrr]);powers=np.array([r['drivingPower_W'] for r in rrr])
        work=newK-oldK+dn-dt*(powers-losses);maxWork=max(maxWork,float(max(abs(work))))
        require(maxWork<1e-6,'Accepted per-ring kinetic-work ledger')
        physical+=dt*sum(losses);drive+=dt*sum(powers);numHeat+=sum(dn);transfer+=dt*sum(r['absoluteAdvectivePower_W'] for r in rrr)
        density=max(density,max(r['densityFraction'] for r in rrr))
        gross+=dt*np.array([sum(a['out'] for a in aa),sum(a['back'] for a in aa),sum(r['out'] for r in rrr),sum(r['back'] for r in rrr)])
        maxLM=max(maxLM,max(abs(rr[:5]))*s['localMassTolerance_kg']);maxLE=max(maxLE,max(abs(rr[5:11]))*s['localEnergyTolerance_J'])
        maxModal=max(maxModal,max(abs(rr[11:]))*ib['modalResidual_kg_s'])
        maxM=max(maxM,abs(sum(old[:,0])-M0));maxE=max(maxE,abs(sum(old[:,1])+s['calorimeterCapacity_J_K']*Tc+sum(newK)-E0))
        entropy=sum(old[:,2])+s['calorimeterCapacity_J_K']*math.log(Tc);minDS=min(minDS,entropy-prevS);prevS=entropy
        if maxM>s['totalMassTolerance_kg'] or maxE>s['totalEnergyTolerance_J'] or minDS < -s['entropyTolerance_J_K']:
            return dict(name=name,status='REJECTED_LEDGER',attemptedTime_s=(step+1)*dt,maxMassDefect_kg=maxM,maxEnergyDefect_J=maxE,
              minimumEntropyIncrement_J_K=minDS,lastAcceptedTime_s=step*dt,lastAcceptedState=acceptedX.tolist(),
              trialState=x.tolist(),trace=trace,wall_s=time.perf_counter()-started)
        if abs((step+1)*dt/.01-round((step+1)*dt/.01))<1e-8:record((step+1)*dt)
    audits=[]
    for row in [trace[0],trace[-1]]:
        pp=[profile(p,T+273.15) for p,T in zip(row['topPressures_Pa'],row['temperatures_C'])];mm=np.array(row['modes_kg_m2_s'])
        _,aa,rr=coupled_rates(pp,mm,geom,ig,32)
        mass=max(abs(a[k]-bb[k]) for a,bb in zip(row['apertures']+row['returns'],aa+rr) for k in ['q','out','back'])
        energy=max([abs(a['energy']-bb['energy']) for a,bb in zip(row['apertures'],aa)]+
          [abs(a[k]-bb[k]) for a,bb in zip(row['returns'],rr) for k in ['leftEnergy_W','rightEnergy_W','drivingPower_W','dissipation_W']])
        require(mass<.001 and energy<100,'Initial/final independent 16/32 signed mass and energy quadrature')
        audits.append(dict(t_s=row['t_s'],mass_kg_s=mass,energy_W=energy))
    held=None
    if matched:
        dp=max(abs(a-b) for row in trace for a,b in zip(row['topPressures_Pa'],trace[0]['topPressures_Pa']))
        dT=max(abs(a-b) for row in trace for a,b in zip(row['temperatures_C'],trace[0]['temperatures_C']))
        flow=max(r[k] for row in trace for r in row['apertures']+row['returns'] for k in ['out','back'])
        require(dp<.01 and dT<1e-7 and flow<1e-7,'Actual held pressure temperature and gross flow')
        held=dict(pressure_Pa=dp,temperature_K=dT,gross_kg_s=flow)
    numericalFraction=numHeat/physical if physical>ib['zeroDissipationEnergy_J'] else None
    print(json.dumps(dict(name=name,status='COMPLETED',wall_s=time.perf_counter()-started)),file=sys.stderr,flush=True)
    return dict(name=name,status='COMPLETED',step_s=dt,geometry=geom,inertia=ig,initialization=initialization,
      maxMassDefect_kg=maxM,maxEnergyDefect_J=maxE,maxLocalMassDefect_kg=maxLM,maxLocalEnergyDefect_J=maxLE,
      maxModalEquivalentResidual_kg_s=maxModal,maxKineticWorkDefect_J=maxWork,minimumEntropyIncrement_J_K=minDS,
      entropyChange_J_K=prevS-S0,physicalDissipation_J=physical,drivingWork_J=drive,numericalKineticHeat_J=numHeat,
      numericalToPhysicalHeatFraction=numericalFraction,numericalToAdvectiveFraction=numHeat/transfer if transfer>0 else None,
      numericalHeatScreen=bool(numericalFraction<ib['maximumNumericalHeatFraction']) if numericalFraction is not None else bool(numHeat<=ib['zeroDissipationEnergy_J']),
      maximumDensityFraction=density,densityScreen=bool(density<=ib['maximumDensityFraction']),
      trace=trace,audit=audits,held=held,halfJacobianAudit=halfAudit,nfev=nfev,wall_s=time.perf_counter()-started)
`

export const inertiaCalculation = inertiaDefinitions + String.raw`
def output_scalar(value):
    if isinstance(value,np.generic):return value.item()
    raise TypeError('Unsupported output value: '+type(value).__name__)
def output_json(value):return json.dumps(value,default=output_scalar,allow_nan=False)
for value in [dict(flag=np.bool_(False)),dict(flag=np.bool_(True)),dict(status='REJECTED',value=np.float64(0.))]:output_json(value)
primitives=primitive_checks();batch=b['batch'];cases=[];startup=None
if batch=='primitive':pass
elif batch=='startup':startup=startup_linearization()
elif batch=='first':
    cases=[run_inertia('held',s['steps_s'][0],.01,matched=True),run_inertia('receipt',s['steps_s'][0],s['firstDuration_s']),run_inertia('receipt_fine',s['steps_s'][1],s['firstDuration_s'])]
elif batch in ['cooling','cooling_fine']:
    cases=[run_inertia(batch,s['steps_s'][0 if batch=='cooling' else 1],s['challengeDuration_s'],True)]
elif batch=='compare':cases=b['retainedCases']
comparison=compare(cases[-2],cases[-1]) if batch in ['first','compare'] else None
if comparison and comparison['evaluated']:
    comparison['numericalHeatDecreases']=bool(cases[-1]['numericalKineticHeat_J']<cases[-2]['numericalKineticHeat_J'] or cases[-2]['numericalKineticHeat_J']<=ib['zeroDissipationEnergy_J'])
print(output_json(dict(dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__),
  cache=dict(policy='Exact float keys; immutable values; no property approximation',isentropic=isentrope.cache_info()._asdict(),gauss=leggauss.cache_info()._asdict()),
  scope='Finite two-mode return inertia on existing patch water; no vertical transport or resolved patch momentum',primitives=primitives,
  startupLinearization=startup,cases=cases,temporalComparison=comparison)))
`

if (import.meta.main) {
  const [owner, python, batch, coarsePath, finePath] = process.argv.slice(2)
  if (!owner || !python || !['primitive', 'startup', 'first', 'cooling', 'cooling_fine', 'compare'].includes(batch ?? '') ||
    process.argv.length !== (batch === 'compare' ? 7 : 5)) {
    throw new Error('Usage: cmt-inertia.ts owner.md python primitive|startup|first|cooling|cooling_fine|compare [coarse.json fine.json]')
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const source = await Bun.file(import.meta.path).text()
  const basis = parseInertiaBasis(await Bun.file(owner).text())
  const input = { ...basis, batch }
  let executionInput: object = input
  let comparisonArtifacts: Array<{ path: string; sha256: string }> | undefined
  if (batch === 'compare') {
    const texts = await Promise.all([Bun.file(coarsePath!).text(), Bun.file(finePath!).text()])
    const artifacts = texts.map(text => JSON.parse(text))
    for (const [i, artifact] of artifacts.entries()) {
      const expectedCase = i === 0 ? 'cooling' : 'cooling_fine'
      if (artifact.calculationHash !== hash(inertiaCalculation) || artifact.sourceHash !== hash(source) ||
        JSON.stringify(artifact.input) !== JSON.stringify({ ...basis, batch: expectedCase }) ||
        artifact.cases?.length !== 1 || artifact.cases[0].name !== expectedCase) {
        throw new Error('Cooling comparison requires current identical source/basis and ordered retained cases')
      }
    }
    comparisonArtifacts = texts.map((text, i) => ({ path: i === 0 ? coarsePath! : finePath!, sha256: hash(text) }))
    executionInput = { ...input, retainedCases: artifacts.map(a => a.cases[0]) }
  }
  const child = Bun.spawn([python, '-c', inertiaCalculation], { stdin: new Blob([JSON.stringify(executionInput)]), stdout: 'pipe', stderr: 'inherit' })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT inertia calculation failed')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(inertiaCalculation),
    sourceHash: hash(source), comparisonArtifacts, ...JSON.parse(output) }, null, 2))
}

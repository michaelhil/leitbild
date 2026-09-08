/** Finite ring-local receiving/return network in an explicitly quasisteady momentum limit. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { apertureDefinitions, parseApertureBasis } from './reference-design-cmt-inlet'

const positive = z.number().finite().positive()
const patchSchema = z.object({
  bodyRadius_m: positive, pitch_m: positive, extentDiameters: z.tuple([z.literal(1), z.literal(2)]),
  returnLoss: positive, initialPlenum_C: z.number().finite(), initialResident_C: z.number().finite(),
  firstDuration_s: positive, challengeDuration_s: positive, steps_s: z.tuple([positive, positive]),
  coolingStart_s: positive, coolingConductance_W_K: positive, calorimeterCapacity_J_K: positive,
  calorimeterInitial_C: z.number().finite(), localMassTolerance_kg: positive, localEnergyTolerance_J: positive,
  totalMassTolerance_kg: positive, totalEnergyTolerance_J: positive, entropyTolerance_J_K: positive,
  temporalTemperature_K: positive, temporalPressure_Pa: positive, temporalGrossFraction: positive,
}).strict().superRefine((s, c) => {
  if (s.steps_s[0] !== 2 * s.steps_s[1] || s.extentDiameters[1] !== 2 * s.extentDiameters[0] ||
    s.coolingStart_s >= s.challengeDuration_s || s.steps_s.some(dt =>
      [s.firstDuration_s, s.challengeDuration_s, s.coolingStart_s, .01].some(t => Math.abs(t / dt - Math.round(t / dt)) > 1e-8))) {
    c.addIssue({ code: 'custom', message: 'Frozen case, sample and event clocks must align' })
  }
  if (s.bodyRadius_m !== .205 || s.pitch_m !== .075) c.addIssue({ code: 'custom', message: 'Geometry must match the owned bare rings' })
})

export function parsePatchBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-patches\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-patches block')
  return { ...parseApertureBasis(document), patches: patchSchema.parse(JSON.parse(blocks[0]![1]!)) }
}

export const patchDefinitions = apertureDefinitions + String.raw`
import platform,iapws,scipy
from iapws._iapws import _ThCond
s=b['patches'];zz=np.array(b['ringElevations_m']);checks=0
def require(ok,message):
    global checks
    checks+=1
    if not ok:raise ValueError(message)

def geometry(factor):
    r0=s['bodyRadius_m'];r1=r0+factor*b['holeDiameter_m'];area=math.pi*(r1*r1-r0*r0)
    return dict(r0=r0,r1=r1,area=area,volume=area*s['pitch_m'],outerArea=2*math.pi*r1*s['pitch_m'],length=r1-r0)

def profile(p,T):
    w=water(p,T)
    return dict(p=p,T=T,rho0=w['rho'])

def at(w,z):
    p=w['p']+w['rho0']*g*(12-z)
    return p,water(p,w['T'])

def integral(w,lo,hi,area,n):
    x,q=leggauss(n);out=np.zeros(3)
    for a,weight in zip(x,q):
        z=(lo+hi)/2+(hi-lo)*a/2;dv=area*(hi-lo)*weight/2;p,v=at(w,z);m=dv*v['rho']
        out+=m*np.array([1.,v['u']+g*z,v['s']])
    return out

def inventories(profiles,geom,n=4):
    out=[]
    pl=integral(profiles[0],11.725,11.975,bodyArea,8);w=water(profiles[0]['p'],profiles[0]['T'])
    pl+=headerVolume*w['rho']*np.array([1.,w['u']+g*12,w['s']]);out.append(pl)
    for j,z in enumerate(zz):out.append(integral(profiles[j+1],z-s['pitch_m']/2,z+s['pitch_m']/2,geom['area'],n))
    resident=integral(profiles[4],6.,12.,10.,8)
    for z in zz:resident-=integral(profiles[4],z-s['pitch_m']/2,z+s['pitch_m']/2,geom['area'],n)
    out.append(resident)
    return np.array(out)

def face(a,bb,lo,hi,areaDensity,n,circular=None):
    # Delta-p is affine for the selected reference-density hydrostatic reduction.
    def delta(z):return a['p']-bb['p']+(a['rho0']-bb['rho0'])*g*(12-z)
    cuts=[lo,hi];dl=delta(lo);dh=delta(hi)
    if dl*dh<0:cuts.insert(1,lo+(hi-lo)*(-dl)/(dh-dl))
    nn,ww=leggauss(n);q=energy=out=back=power=0.
    for lower,upper in zip(cuts[:-1],cuts[1:]):
        if circular is not None:
            center,rad=circular;aa=math.asin(max(-1.,min(1.,(lower-center)/rad)));be=math.asin(max(-1.,min(1.,(upper-center)/rad)))
        else:aa=lower;be=upper
        for node,weight in zip(nn,ww):
            t=(node+1)/2;x=aa+(be-aa)*math.sin(math.pi*t/2)**2;jac=(be-aa)*math.pi/2*math.sin(math.pi*t)*weight/2
            if circular is not None:
                z=center+rad*math.sin(x);da=2*rad*rad*math.cos(x)**2*jac*areaDensity
            else:z=x;da=areaDensity*jac
            dp=delta(z);donor=a if dp>=0 else bb;p,w=at(donor,z)
            dq=da*math.copysign(math.sqrt(2*w['rho']*abs(dp)),dp)
            q+=dq;energy+=dq*(w['h']+g*z);out+=max(dq,0);back+=max(-dq,0);power+=dq*dp/w['rho']
    require(power>=-1e-10,'Nonnegative local hydraulic dissipation')
    return dict(q=q,energy=energy,out=out,back=back,power=power)

def fluxes(profiles,geom,n=16):
    rates=np.zeros((5,2));ap=[];ret=[]
    for j,z in enumerate(zz):
        f=face(profiles[0],profiles[j+1],z-radius,z+radius,b['holesPerRing']*b['coefficient'],n,(z,radius))
        r=face(profiles[j+1],profiles[4],z-s['pitch_m']/2,z+s['pitch_m']/2,2*math.pi*geom['r1']/math.sqrt(s['returnLoss']),n)
        rates[0]-=[f['q'],f['energy']];rates[j+1]+=[f['q']-r['q'],f['energy']-r['energy']];rates[4]+=[r['q'],r['energy']]
        ap.append(f);ret.append(r)
    molecular=[]
    for j in range(2):
        a=profiles[j+1];bb=profiles[j+2];wa=water(a['p'],a['T']);wb=water(bb['p'],bb['T'])
        ka=_ThCond(wa['rho'],a['T']);kb=_ThCond(wb['rho'],bb['T']);k=2*ka*kb/(ka+kb)
        q=k*geom['area']/s['pitch_m']*(a['T']-bb['T']);rates[j+1,1]-=q;rates[j+2,1]+=q;molecular.append(q)
    return rates,dict(apertures=ap,returns=ret,molecularHeat_W=molecular)

def decode(x):
    p=x[0]*1e7;pp=np.r_[p+100*x[1:5],p];TT=x[5:10]*500
    return [profile(p,T) for p,T in zip(pp,TT)],x[10]*500

def encode(pp,TT,Tc):return np.r_[pp[4]/1e7,(pp[:4]-pp[4])/100,np.array(TT)/500,Tc/500]

def initial(geom,matched=False):
    p=b['pressure_MPa']*1e6;TT=np.array([s['initialResident_C'] if matched else s['initialPlenum_C']]+[s['initialResident_C']]*4)+273.15
    def hydraulic(heads):
        w,_=decode(encode(np.r_[p+heads*100,p],TT,s['calorimeterInitial_C']+273.15));rates,f=fluxes(w,geom)
        return rates[:4,0]
    sol=root(hydraulic,np.zeros(4),options=dict(xtol=1e-11));rr=hydraulic(sol.x)
    require(np.all(np.isfinite(sol.x)) and max(abs(rr))<1e-6,'Initial stationary hydraulic projection')
    return encode(np.r_[p+100*sol.x,p],TT,s['calorimeterInitial_C']+273.15)

def run(name,dt,duration,cooling=False,factor=1.,matched=False):
    started=time.perf_counter();geom=geometry(factor);x=initial(geom,matched);w,Tc=decode(x);old=inventories(w,geom)
    M0=sum(old[:,0]);E0=sum(old[:,1])+s['calorimeterCapacity_J_K']*Tc;S0=sum(old[:,2])+s['calorimeterCapacity_J_K']*math.log(Tc)
    trace=[];maxM=maxE=maxLocalM=maxLocalE=0.;minDS=float('inf');previousS=S0;nfev=0;gross=np.zeros(4);jacobianAudit=None
    def record(t):
        rates,f=fluxes(w,geom);f['netAperture_kg_s']=sum(a['q'] for a in f['apertures'])
        scales=[]
        for j,r in enumerate(f['returns']):
            rho=water(w[j+1]['p'],w[j+1]['T'])['rho'];speed=(r['out']+r['back'])/(rho*geom['outerArea'])
            tau=geom['length']/(s['returnLoss']*speed) if speed>0 else None
            incoming=f['apertures'][j]['out']+r['back'];turnover=old[j+1,0]/incoming if incoming>0 else None
            scales.append(dict(grossReturnSpeed_m_s=speed,linearizedInertanceLossScale_s=tau,
              actualPatchReceiptTurnover_s=turnover,inertanceToReceiptRatio=tau/turnover if tau is not None and turnover is not None else None))
        trace.append(dict(t_s=t,topPressures_Pa=[a['p'] for a in w],temperatures_C=[a['T']-273.15 for a in w],calorimeter_C=Tc-273.15,
          grossIntegrated_kg=gross.tolist(),scales=scales,**f))
    record(0.)
    for step in range(round(duration/dt)):
        enabled=cooling and step*dt>=s['coolingStart_s']-1e-12;oldTc=Tc
        lastTrial=None
        def residual(trial):
            nonlocal lastTrial
            lastTrial=trial.copy()
            ww,cc=decode(trial);new=inventories(ww,geom);rate,f=fluxes(ww,geom)
            heat=s['coolingConductance_W_K']*(ww[0]['T']-cc) if enabled else 0.;rate[0,1]-=heat
            delta=new[:,:2]-old[:,:2]-dt*rate
            return np.r_[delta[:,0]/s['localMassTolerance_kg'],delta[:,1]/s['localEnergyTolerance_J'],
              (s['calorimeterCapacity_J_K']*(cc-oldTc)-dt*heat)/s['localEnergyTolerance_J']]
        increments=np.r_[1./1e7,np.full(4,.001/100),np.full(6,1e-4/500)]
        def jacobian(trial,factor=1.):
            columns=[]
            for k,h in enumerate(increments*factor):
                a=trial.copy();bb=trial.copy();a[k]+=h;bb[k]-=h
                columns.append((residual(a)-residual(bb))/(2*h))
            return np.array(columns).T
        if step==0:
            defaultStep=np.sqrt(np.finfo(float).eps)*(abs(x[3]) if x[3]!=0 else 1.);perturbed=x.copy();perturbed[3]+=defaultStep
            oldProfiles,_=decode(x);newProfiles,_=decode(perturbed)
            j=jacobian(x);jh=jacobian(x,.5)
            jacobianAudit=dict(defaultMiddleHeadCoordinateStep=defaultStep,
              actualMiddlePressureChange_Pa=newProfiles[2]['p']-oldProfiles[2]['p'],
              actualDefaultCallbackChange=float(max(abs(residual(perturbed)-residual(x)))),
              selectedMiddleColumnNorm=float(np.linalg.norm(j[:,3])),halfMiddleColumnNorm=float(np.linalg.norm(jh[:,3])),
              physicalPerturbations=dict(commonPressure_Pa=1.,head_Pa=.001,temperature_K=1e-4))
        try:sol=root(residual,x,jac=jacobian,options=dict(xtol=1e-12))
        except ValueError as error:
            if str(error)!='Aperture rig outside liquid domain':raise
            return dict(name=name,status='REJECTED_PROPERTY_TRIAL',attemptedTime_s=(step+1)*dt,lastAcceptedTime_s=step*dt,
              lastAcceptedState=x.tolist(),trialState=lastTrial.tolist(),reason=str(error),trace=trace,wall_s=time.perf_counter()-started)
        rr=residual(sol.x);nfev+=sol.nfev
        if not np.all(np.isfinite(sol.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1:
            return dict(name=name,status='REJECTED_LOCAL_RESIDUAL',attemptedTime_s=(step+1)*dt,lastAcceptedTime_s=step*dt,
              residualInToleranceUnits=rr.tolist(),lastAcceptedState=x.tolist(),trialState=sol.x.tolist(),nfev=sol.nfev,
              solverMessage=str(sol.message),trace=trace,wall_s=time.perf_counter()-started)
        if step==0:
            half=root(residual,x,jac=lambda a:jacobian(a,.5),options=dict(xtol=1e-12));hr=residual(half.x)
            aa,ac=decode(sol.x);bb,bc=decode(half.x)
            dp=max(abs(a['p']-b['p']) for a,b in zip(aa,bb));dT=max(abs(a['T']-b['T']) for a,b in zip(aa,bb))
            require(max(abs(hr))<=1 and dp<.1 and dT<1e-6,'Half-Jacobian-perturbation first-step same-root check')
            jacobianAudit.update(solvedStepHalfPressureDifference_Pa=dp,solvedStepHalfTemperatureDifference_K=dT,
              solvedStepResidual=float(max(abs(rr))),halfStepResidual=float(max(abs(hr))),
              solvedMiddleColumnNorm=float(np.linalg.norm(jacobian(sol.x)[:,3])),solvedHalfMiddleColumnNorm=float(np.linalg.norm(jacobian(sol.x,.5)[:,3])))
        x=sol.x;w,Tc=decode(x);old=inventories(w,geom);rates,f=fluxes(w,geom)
        gross+=dt*np.array([sum(a['out'] for a in f['apertures']),sum(a['back'] for a in f['apertures']),sum(a['out'] for a in f['returns']),sum(a['back'] for a in f['returns'])])
        maxLocalM=max(maxLocalM,max(abs(rr[:5]))*s['localMassTolerance_kg']);maxLocalE=max(maxLocalE,max(abs(rr[5:]))*s['localEnergyTolerance_J'])
        maxM=max(maxM,abs(sum(old[:,0])-M0));maxE=max(maxE,abs(sum(old[:,1])+s['calorimeterCapacity_J_K']*Tc-E0))
        entropy=sum(old[:,2])+s['calorimeterCapacity_J_K']*math.log(Tc);minDS=min(minDS,entropy-previousS);previousS=entropy
        if maxM>s['totalMassTolerance_kg'] or maxE>s['totalEnergyTolerance_J'] or minDS < -s['entropyTolerance_J_K']:
            return dict(name=name,status='REJECTED_LEDGER',attemptedTime_s=(step+1)*dt,maxMassDefect_kg=maxM,maxEnergyDefect_J=maxE,minimumEntropyIncrement_J_K=minDS,trace=trace)
        if abs((step+1)*dt/.01-round((step+1)*dt/.01))<1e-8:record((step+1)*dt)
    audit=[]
    for row in [trace[0],trace[-1]]:
        prof=[profile(p,T+273.15) for p,T in zip(row['topPressures_Pa'],row['temperatures_C'])];fine=fluxes(prof,geom,32)[1]
        err=max(abs(a[k]-bb[k]) for field in ['apertures','returns'] for a,bb in zip(row[field],fine[field]) for k in ['q','out','back'])
        energyErr=max(abs(a['energy']-bb['energy']) for field in ['apertures','returns'] for a,bb in zip(row[field],fine[field]))
        hydro=max(abs(at(v,z)[0]-pressure(v['p'],v['T'],z)) for v in prof for z in [zz[0]+radius,zz[-1]-radius])
        heads=[]
        for j,z in enumerate(zz):
            for label,a,bb,lo,hi in [('aperture',prof[0],prof[j+1],z-radius,z+radius),('return',prof[j+1],prof[4],z-s['pitch_m']/2,z+s['pitch_m']/2)]:
                def approx(zz):return at(a,zz)[0]-at(bb,zz)[0]
                points=[lo,hi];dl=approx(lo);dh=approx(hi)
                if dl*dh<0:points.append(lo+(hi-lo)*(-dl)/(dh-dl))
                for zz0 in points:
                    h=approx(zz0);exact=pressure(a['p'],a['T'],zz0)-pressure(bb['p'],bb['T'],zz0)
                    heads.append(dict(face=label,ring=j,z_m=zz0,approximateHead_Pa=h,exactIsothermalHead_Pa=exact,
                      headError_Pa=h-exact,edge=bool(zz0==lo or zz0==hi)))
        audit.append(dict(t_s=row['t_s'],flux16vs32_kg_s=err,energy16vs32_W=energyErr,hydroApproximationAtRings_Pa=hydro,pairedHeads=heads))
    require(max(a['flux16vs32_kg_s'] for a in audit)<.001,'Actual receipt/return quadrature screen')
    require(max(a['energy16vs32_W'] for a in audit)<100,'Counterflow energy quadrature screen')
    held=None
    if matched:
        dp=max(abs(a-b) for row in trace for a,b in zip(row['topPressures_Pa'],trace[0]['topPressures_Pa']))
        dT=max(abs(a-b) for row in trace for a,b in zip(row['temperatures_C'],trace[0]['temperatures_C']))
        flow=max(a[k] for row in trace for f in ['apertures','returns'] for a in row[f] for k in ['out','back'])
        require(dp<.01 and dT<1e-7 and flow<1e-7,'Actual held state drift and gross flow')
        held=dict(maxPressureDrift_Pa=dp,maxTemperatureDrift_K=dT,maxGrossFlow_kg_s=flow)
    print(json.dumps(dict(name=name,status='COMPLETED',wall_s=time.perf_counter()-started)),file=sys.stderr,flush=True)
    return dict(name=name,status='COMPLETED',step_s=dt,geometry=geom,maxMassDefect_kg=maxM,maxEnergyDefect_J=maxE,
      maxLocalMassDefect_kg=maxLocalM,maxLocalEnergyDefect_J=maxLocalE,minimumEntropyIncrement_J_K=minDS,
      entropyChange_J_K=previousS-S0,trace=trace,audit=audit,held=held,jacobianAudit=jacobianAudit,nfev=nfev,wall_s=time.perf_counter()-started)

def compare(a,bb):
    if a['status']!='COMPLETED' or bb['status']!='COMPLETED':return dict(evaluated=False,passed=False)
    require(len(a['trace'])==len(bb['trace']),'Common output count');dT=dp=dG=0.
    for x,y in zip(a['trace'],bb['trace']):
        require(x['t_s']==y['t_s'],'Common physical clocks')
        dT=max(dT,*[abs(v-w) for v,w in zip(x['temperatures_C'],y['temperatures_C'])],abs(x['calorimeter_C']-y['calorimeter_C']))
        dp=max(dp,*[abs(v-w) for v,w in zip(x['topPressures_Pa'],y['topPressures_Pa'])])
    dG=max(abs(v-w)/max(abs(w),1e-12) for v,w in zip(a['trace'][-1]['grossIntegrated_kg'],bb['trace'][-1]['grossIntegrated_kg']))
    return dict(evaluated=True,temperature_K=dT,pressure_Pa=dp,grossFraction=dG,
      passed=dT<s['temporalTemperature_K'] and dp<s['temporalPressure_Pa'] and dG<s['temporalGrossFraction'])
`

export const patchCalculation = patchDefinitions + String.raw`
def worker(args):return run(*args)
batch=b['batch'];cases=[]
if batch=='first':
    cases=[run('held',s['steps_s'][0],.01,matched=True),run('receipt',s['steps_s'][0],s['firstDuration_s']),run('receipt_fine',s['steps_s'][1],s['firstDuration_s'])]
else:
    import multiprocessing
    args=[('cooling',s['steps_s'][0],s['challengeDuration_s'],True),('cooling_fine',s['steps_s'][1],s['challengeDuration_s'],True),('extent',s['steps_s'][0],s['challengeDuration_s'],True,s['extentDiameters'][1])]
    # Isolated processes receive the same immutable numeric input; map retains case order.
    with multiprocessing.get_context('fork').Pool(2) as pool:cases=pool.map(worker,args)
comparison=compare(cases[-2],cases[-1]) if batch=='first' else compare(cases[0],cases[1])
print(json.dumps(dict(dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__),
  scope='Quasisteady ring-local thermal receiving/return network; no finite momentum storage or tank plume',concurrentWorkers=1 if batch=='first' else 2,cases=cases,temporalComparison=comparison)))
`

if (import.meta.main) {
  const [owner, python, batch] = process.argv.slice(2)
  if (!owner || !python || !['first', 'second'].includes(batch ?? '') || process.argv.length !== 5) {
    throw new Error('Usage: cmt-patches.ts owner.md python first|second')
  }
  const input = { ...parsePatchBasis(await Bun.file(owner).text()), batch }
  const source = await Bun.file(import.meta.path).text()
  const child = Bun.spawn([python, '-c', patchCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT finite-patch calculation failed')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(patchCalculation),
    sourceHash: hash(source), ...JSON.parse(output) }, null, 2))
}

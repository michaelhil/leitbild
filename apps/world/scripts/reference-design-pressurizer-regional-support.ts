/** Offline slow hydraulic/phase response. No live plant, abrupt-bank or thermal-rate qualification. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseConnectedFuel } from './reference-design-connected-fuel'
import { primaryReferencePython, resolveInitializationInput } from './reference-design-initialization'
import { phaseStorageThermodynamics } from './reference-design-pressurizer-phase-storage'
import { parsePressurizerBasis } from './reference-design-pressurizer'
import { parseSurgeRoute, resolveSurgeRoute, surgeRoutePython } from './reference-design-surge-route'

export const regionalSupportCalculation = phaseStorageThermodynamics + String.raw`
import time
from scipy.optimize import root
d=json.load(sys.stdin);exec(d['routeDefinitions']);r=d['route'];cfg=d['pzr'];case=d['case']
start=time.perf_counter();primary={'d':d['primary']};exec(d['primaryDefinitions'],primary)
xn,_=primary['solve'](primary['steady'],primary['xseed'],'actual primary nominal');pn=primary['evaluate'](xn)
iH=primary['names'].index('HOT.A');pH=float(pn['p'][iH]);TH=float(pn['T'][iH])+273.15;hotV=float(primary['V'][iH])
g=primary['g'];A=cfg['area_m2'];Vessel=cfg['volume_m3'];zH=r['sourceElevation_m'];zP=r['receiverElevation_m'];Ap=r['area_m2']
if float(primary['z'][iH])!=zH:raise ValueError('Actual HOT.A and route source elevations differ')
checks=[];calls=dict(property=0,residual=0,nonlinear=0);half=r['developedLength_m']/2
propertyEntropyError_J_kgK=0.;refinedEntropyError_J_kgK=0.
calls.update(entropyRefinements=0,explicitForwardPropertyCalls=0)
def w(p,**pair):
    global propertyEntropyError_J_kgK,refinedEntropyError_J_kgK
    calls['property']+=1
    if not 14<p<16:raise ValueError('Outside near-nominal phase/pressure investigation')
    q=W(P=p,**pair)
    if 's' in pair:
        target=pair['s']*1000;error=q.s*1000-target
        propertyEntropyError_J_kgK=max(propertyEntropyError_J_kgK,abs(error))
        if abs(error)>1e-9:
            calls['entropyRefinements']+=1
            f=W(P=p,x=0);v=W(P=p,x=1);calls['explicitForwardPropertyCalls']+=2
            if f.s*1000<=target<=v.s*1000:
                quality=(target-f.s*1000)/(1000*(v.s-f.s))
                water.update(CP.PQ_INPUTS,p*1e6,quality);calls['explicitForwardPropertyCalls']+=1
            else:
                isLiquid=target<f.s*1000;quality=0. if isLiquid else 1.;T=q.T
                water.specify_phase(CP.iphase_liquid if isLiquid else CP.iphase_gas)
                try:
                    for _ in range(8):
                        water.update(CP.PT_INPUTS,p*1e6,T);calls['explicitForwardPropertyCalls']+=1
                        defect=water.smass()-target
                        if abs(defect)<=1e-9:break
                        T-=defect*T/water.cpmass()
                    if (isLiquid and T>f.T) or (not isLiquid and T<v.T):raise ValueError('Entropy inverse crossed its stable phase boundary')
                finally:water.unspecify_phase()
            q=SimpleNamespace(P=water.p()/1e6,T=water.T(),rho=water.rhomass(),v=1/water.rhomass(),
                u=water.umass()/1000,s=water.smass()/1000,x=quality)
        corrected=abs(q.s*1000-target);refinedEntropyError_J_kgK=max(refinedEntropyError_J_kgK,corrected)
        if corrected>1e-9:raise ValueError('Forward entropy inversion residual failed')
    if not math.isfinite(q.x) or not 0<=q.x<=1:raise ValueError('Native quality outside physical phase partition')
    return q
def h(q):return q.u*1000+q.P*1e6*q.v
referenceNodes={n:np.polynomial.legendre.leggauss(n) for n in [8,16,32]}
def nodes(lo,hi,n):
    x,weights=referenceNodes[n]
    return lo+(x+1)*(hi-lo)/2,weights*(hi-lo)/2
breaks=sorted(set([0.,half,*np.cumsum(r['lengths_m']).tolist()]))
def line_mesh(n):
    rows=[]
    for lo,hi in zip(breaks[:-1],breaks[1:]):
        xs,weights=nodes(lo,hi,n)
        rows.extend((float(x),route_elevation(r,float(x)),float(weight),0 if x<half else 1) for x,weight in zip(xs,weights))
    return rows
meshes={n:line_mesh(n) for n in [8,16,32]}
bendCenters=[r['lengths_m'][0]+r['lengths_m'][1]/2,r['risingStart_m']+r['lengths_m'][3]/2]
bends=[sum(1 for x in bendCenters if (x<half)==(j==0)) for j in [0,1]]

def liquid(p,s=None,T=None):
    q=w(p,s=s) if s is not None else w(p,T=T)
    if q.x!=0:raise ValueError('HOT/line or bottom withdrawal has left this liquid-port regime')
    # Read from the same state just recovered; no second rounded-state cache.
    mu=water.viscosity();return dict(Mrho=q.rho,h=h(q),u=q.u*1000,s=q.s,T=q.T,mu=mu,p=q.P)

def line(p,s,n=8):
    base=liquid(p,s=s);samples={zH:base};maxHydro=0.
    def at(z):
        nonlocal maxHydro
        if z in samples:return samples[z]
        target=base['h']-g*(z-zH);pp=p-base['Mrho']*g*(z-zH)/1e6
        for _ in range(8):
            q=liquid(pp,s=s);defect=q['h']-target
            if abs(defect)<1e-7:break
            pp-=defect*q['Mrho']/1e6
        q=liquid(pp,s=s);error=abs(q['h']-target)*q['Mrho'];maxHydro=max(maxHydro,error)
        if error>.001:raise ValueError('Physical line hydrostatic enthalpy reconstruction failed')
        samples[z]=q;return q
    M=U=PE=0.;local=[]
    for x,z,weight,j in meshes[n]:
        q=at(z);dm=Ap*weight*q['Mrho'];M+=dm;U+=dm*q['u'];PE+=dm*g*z
        local.append((weight,j,q))
    return dict(M=M,E=U+PE,U=U,PE=PE,inlet=base,outlet=at(zP),local=local,hydroError_Pa=maxHydro)

def region(p,s,M,up,n=8,datum=0.):
    if M<=0:raise ValueError('Spatial owner exhausted; no phase/topology fallback')
    def pressure(m):return p-g*m/A/1e6 if up else p+g*(M-m)/A/1e6
    p0,p1=pressure(0),pressure(M);cuts=[0.,M]
    # Integrate the actual phase boundary rather than smearing it over quadrature nodes.
    for x in [0,1]:
        def boundary(pp):return w(pp,x=x).s-s
        a,b=boundary(p0),boundary(p1)
        if a*b<0:
            ps=brentq(boundary,min(p0,p1),max(p0,p1),xtol=1e-12)
            m=(p-ps)*1e6*A/g if up else M-(ps-p)*1e6*A/g
            cuts.append(m)
    volume=U=moment=gasMass=gasVolume=liquidMass=0.;Tmin=math.inf;Tmax=-math.inf
    for lo,hi in zip(sorted(cuts)[:-1],sorted(cuts)[1:]):
        ms,weights=nodes(lo,hi,n)
        for m,weight in zip(ms,weights):
            q=w(pressure(m),s=s);volume+=weight*q.v;U+=weight*q.u*1000;moment+=weight*(M-m)*q.v
            gasMass+=weight*q.x;liquidMass+=weight*(1-q.x)
            if q.x==1:gasVolume+=weight*q.v
            elif q.x>0:gasVolume+=weight*q.x*w(q.P,x=1).v
            Tmin=min(Tmin,q.T);Tmax=max(Tmax,q.T)
    PE=g*datum*M+g/A*moment
    return dict(M=M,E=U+PE,U=U,PE=PE,V=volume,gasMass=gasMass,gasVolume=gasVolume,
        liquidMass=liquidMass,Tmin=Tmin,Tmax=Tmax,pBottom=p0,pTop=p1)

hotNom=liquid(pH,T=TH);lineNom=line(pH,hotNom['s']);pBottom=lineNom['outlet']['p']
def nominal_lower(ps):
    m=(pBottom-ps)*1e6*A/g;s=w(ps,x=0).s
    return region(ps,s,m,False,datum=zP),s
ps=brentq(lambda p:nominal_lower(p)[0]['V']-cfg['liquidVolume_m3'],pBottom-.05,pBottom-.02,xtol=1e-12)
low,sL=nominal_lower(ps);ML=low['M'];VU=Vessel-low['V']
def nominal_upper(m):
    pt=ps-g*m/A/1e6;s=w(pt,x=1).s
    return region(ps,s,m,True,datum=zP+low['V']/A),s
MU=brentq(lambda m:nominal_upper(m)[0]['V']-VU,w(ps,x=1).rho*VU*.8,w(ps,x=1).rho*VU*1.2,xtol=1e-8)
upper,sU=nominal_upper(MU)
# Native thermodynamic coordinates; Mupper is eliminated by its exact closed mass balance.
x0=np.array([pH,TH,pH,hotNom['s'],ML,sL,sU,ps,0.,0.])
scales=np.array([15.,600.,15.,1.,10000.,1.,1.,15.,1.,1.])

def evaluate(x,n=8):
    hot=liquid(x[0],T=x[1]);pipe=line(x[2],x[3],n)
    lower=region(x[7],x[5],x[4],False,n,zP);level=lower['V']/A
    upper=region(x[7],x[6],MU,True,n,zP+level)
    if not 0<lower['V']<Vessel or lower['gasVolume']/lower['V']>.05 or upper['liquidMass']/MU>.05:
        raise ValueError('Outside small-phase-fraction, retained-spatial-owner comparison')
    bottom=liquid(lower['pBottom'],s=x[5])
    mh=hotV*hot['Mrho'];M=np.array([mh,pipe['M'],lower['M'],MU])
    E=np.array([mh*(hot['u']+g*zH),pipe['E'],lower['E'],upper['E']]);q=x[8:]
    donors=[hot if q[0]>=0 else pipe['inlet'],pipe['outlet'] if q[1]>=0 else bottom]
    flux=np.array([q[0]*(donors[0]['h']+g*zH),q[1]*(donors[1]['h']+g*zP)])
    losses=np.zeros(2);reynolds=[]
    for weight,j,state in pipe['local']:
        if q[j]==0:reynolds.append(0.);continue
        re=abs(q[j])*r['internalDiameter_m']/(Ap*state['mu']);reynolds.append(re)
        f=math.exp(log_darcy_factor(re,r['roughness_m']/r['internalDiameter_m']))
        losses[j]+=f*weight/r['internalDiameter_m']*q[j]*abs(q[j])/(2*state['Mrho']*Ap*Ap)
    # Entry/discharge follows each physical face's actual sign, not total-route direction.
    minor=[r['entryLoss'] if q[0]>=0 else r['exitLoss'],r['exitLoss'] if q[1]>=0 else r['entryLoss']]
    for j in [0,1]:
        k=(minor[j]+bends[j]*r['elbowLoss'])*case['minorMultiplier']
        losses[j]+=k*q[j]*abs(q[j])/(2*donors[j]['Mrho']*Ap*Ap)
    hydro=np.array([(x[0]-pipe['inlet']['p'])*1e6,(pipe['outlet']['p']-bottom['p'])*1e6])-losses
    return dict(M=M,E=E,flux=flux,hydro=hydro,losses=losses,q=q.copy(),lower=lower,upper=upper,pipe=pipe,
        level=level,volumeResidual=lower['V']+upper['V']-Vessel,
        entropy_J_K=1000*(M[0]*hot['s']+M[1]*x[3]+M[2]*x[5]+MU*x[6]),
        reynoldsMin=min(reynolds),reynoldsMax=max(reynolds))

initial=evaluate(x0);dt=case['dt_s'];sign=case['heatSign'];duration=35.;rise=30.
def heat(t):
    t=min(max(t,0.),rise)
    return sign*3e6*(t/rise-math.sin(2*math.pi*t/rise)/(2*math.pi))
meter0=time.perf_counter();rows=[];maximum=dict(localMass_kg=0.,localEnergy_J=0.,hydraulicResidual_Pa=0.,
    globalMass_kg=0.,globalEnergy_J=0.,volume_m3=0.,quadratureMass_kg=0.,quadratureEnergy_J=0.,quadratureVolume_m3=0.)
qHistory=[];x=x0.copy();old=initial;t=0.;entropyInput=0.;failure=None;maxLoss=0.;maxLossState=x0.copy()
def record(t,x,e):
    rows.append(dict(time_s=t,hotPressure_MPa=x[0],lineHydrostaticReferencePressure_MPa=x[2],surfacePressure_MPa=x[7],
        hotTemperature_C=x[1]-273.15,level_m=e['level'],hotToLine_kg_s=float(x[8]),lineToPzr_kg_s=float(x[9]),
        lowerVaporMass_kg=e['lower']['gasMass'],lowerVoidFraction=e['lower']['gasVolume']/e['lower']['V'],
        upperFogMass_kg=e['upper']['liquidMass'],lowerTmin_K=e['lower']['Tmin'],lowerTmax_K=e['lower']['Tmax'],
        upperTmin_K=e['upper']['Tmin'],upperTmax_K=e['upper']['Tmax'],
        mass_kg=e['M'].tolist(),energy_J=e['E'].tolist(),heat_J=heat(t),
        fluidEntropyMinusReversibleHeatEstimate_J_K=e['entropy_J_K']-initial['entropy_J_K']-entropyInput,
        faceLumpedLosses_Pa=e['losses'].tolist(),
        reynoldsMin=e['reynoldsMin'],reynoldsMax=e['reynoldsMax']))
record(t,x,old);qHistory.append([t,*x[8:]])
while t<duration-1e-9:
    if time.perf_counter()-meter0>180:
        failure=dict(reason='Execution budget; remaining comparison unresolved',lastAcceptedTime_s=t);break
    target=round(t+dt,9);Q=heat(target)-heat(t);before=x.copy()
    def residual(y,physical=False):
        calls['residual']+=1;trial=y*scales;e=evaluate(trial);q=e['q'];F=e['flux']
        work=.5*(trial[7]+x[7])*1e6*A*(e['level']-old['level'])
        mass=e['M'][:3]-old['M'][:3]-dt*np.array([-q[0],q[0]-q[1],q[1]])
        energy=e['E']-old['E']-dt*np.array([-F[0],F[0]-F[1],F[1],0.])-np.array([Q,0.,-work,work])
        raw=np.r_[mass,energy,e['volumeResidual'],e['hydro']]
        return raw if physical else raw/np.array([1.,1.,1.,1e6,1e6,1e6,1e6,.001,1.,1.])
    trial=None;sol=None;r0=None
    try:
        calls['nonlinear']+=1;sol=root(residual,x/scales,tol=1e-12);trial=sol.x*scales;r0=residual(sol.x,True);e=evaluate(trial)
        if max(abs(r0[:3]))>1e-7 or max(abs(r0[3:7]))>.1 or abs(r0[7])>1e-8 or max(abs(r0[8:]))>.001:
            raise ValueError('Unaccepted conservative/hydraulic residual '+str(r0.tolist()))
        for key,value in [('localMass_kg',max(abs(r0[:3]))),('localEnergy_J',max(abs(r0[3:7]))),
            ('hydraulicResidual_Pa',max(abs(r0[8:]))),('volume_m3',abs(r0[7])),
            ('globalMass_kg',abs(sum(e['M']-initial['M']))),('globalEnergy_J',abs(sum(e['E']-initial['E'])-heat(target)))]:maximum[key]=max(maximum[key],float(value))
        if maximum['globalMass_kg']>1e-6 or maximum['globalEnergy_J']>1.:raise ValueError('Global finite-owner ledger failed')
        if sum(abs(e['losses']))>maxLoss:maxLoss=float(sum(abs(e['losses'])));maxLossState=trial.copy()
        entropyInput+=Q/(.5*(x[1]+trial[1]));x=trial;old=e;t=target
        record(t,x,e);qHistory.append([t,*x[8:]])
    except (ValueError,RuntimeError) as error:
        if not np.array_equal(x,before):raise ValueError('Rejected step mutated accepted state')
        failure=dict(reason=str(error),attemptedTime_s=target,lastAcceptedTime_s=t,
            trialState=trial.tolist() if trial is not None else None,rootStatus=str(sol.message) if sol is not None else None,
            physicalResidual=r0.tolist() if r0 is not None else None);break
for state in [x0,x]:
    coarse=evaluate(state);fine=evaluate(state,16)
    maximum['quadratureMass_kg']=max(maximum['quadratureMass_kg'],float(max(abs(fine['M']-coarse['M']))))
    maximum['quadratureEnergy_J']=max(maximum['quadratureEnergy_J'],float(max(abs(fine['E']-coarse['E']))))
    maximum['quadratureVolume_m3']=max(maximum['quadratureVolume_m3'],abs(fine['volumeResidual']-coarse['volumeResidual']))
qh=np.array(qHistory);derivative=np.diff(qh[:,1:],axis=0)/dt
inertia=np.abs(derivative)*(half/Ap);localMax=np.max(inertia,axis=0) if len(inertia) else np.zeros(2)
# Adjacent accepted-flow differences are sampled interval estimates, not a rigorous instantaneous bound.
inertialSum=float(max(np.sum(inertia,axis=1))) if len(inertia) else 0.
complete=failure is None
diagnostic=[]
if failure and failure.get('trialState') is not None:
    for label,state in [('initial',x0),('rejected trial',np.array(failure['trialState']))]:
        e=evaluate(state);repeat=evaluate(state)
        for n in [16,32]:
            fine=evaluate(state,n)
            diagnostic.append(dict(state=label,quadrature=n,energyDifference_J=(fine['E']-e['E']).tolist(),
                massDifference_kg=(fine['M']-e['M']).tolist(),volumeDifference_m3=fine['volumeResidual']-e['volumeResidual'],
                repeatEnergyDifference_J=(repeat['E']-e['E']).tolist()))
endpointQuadrature=[]
for n in [8,16,32]:
    startState=evaluate(x0,n);endState=evaluate(x,n);increment=endState['E']-startState['E']
    endpointQuadrature.append(dict(order=n,energyIncrement_J=increment.tolist(),
        totalEnergyMinusExternalHeat_J=float(sum(increment)-heat(t)),
        initialVolumeResidual_m3=startState['volumeResidual'],finalVolumeResidual_m3=endState['volumeResidual']))
lineAtLoss=line(maxLossState[2],maxLossState[3]);lossSensitivity=[]
for signLoss in [-1,1]:
    shifted=line(maxLossState[2]+signLoss*maxLoss/1e6,maxLossState[3])
    lossSensitivity.append(dict(uniformReferencePressureDisplacement_Pa=signLoss*maxLoss,
        energyDifference_J=shifted['E']-lineAtLoss['E'],massDifference_kg=shifted['M']-lineAtLoss['M']))
print(json.dumps(dict(scope='Finite slow thermal-ramp hydraulic/phase candidate; no abrupt-bank or phase-rate qualification',
    case=case,completed=complete,failure=failure,maximum=maximum,
    inertialOmission=dict(localMaximum_Pa=localMax.tolist(),maximumSumMagnitudes_Pa=inertialSum,
        screen_Pa=10.,passes=bool(complete and max(localMax)<=10 and inertialSum<=10),sampledDerivativeOnly=True),
    initial=dict(state=x0.tolist(),mass_kg=initial['M'].tolist(),energy_J=initial['E'].tolist(),
        liquidRegionVolume_m3=initial['lower']['V'],upperRegionVolume_m3=initial['upper']['V'],
        upperInterfaceSuperheat_K=w(ps,s=sU).T-w(ps,x=1).T,
        lineHydrostaticHead_Pa=(pH-lineNom['outlet']['p'])*1e6,
        oldIsothermalIF97InventoryIsNotReused=True),
    samples=rows,calls=calls,propertyEntropyError_J_kgK=propertyEntropyError_J_kgK,refinedEntropyError_J_kgK=refinedEntropyError_J_kgK,
    failureDiagnostic=diagnostic,endpointQuadrature=endpointQuadrature,
    maximumLumpedLossSum_Pa=maxLoss,lineStoragePressureSensitivity=lossSensitivity,
    propertyCounterScope='wrapper requests and explicit refinement calls; hidden shared W native updates not completely counted',
    finalState=x.tolist(),wallSeconds=time.perf_counter()-start,
    packages=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),
    initializationBasis='IF97 circulating reference selects p/T; HEOS reinitializes finite apparatus M/E independently',
    physicalPhaseRateQualified=False,abruptBankQualified=False,liveRuntime=False),allow_nan=False))
`

type ResponseReceipt = { completed: boolean; case: { heatSign: number; dt_s: number; minorMultiplier: number };
  samples: Array<Record<string, number>> }

/** Predeclared sampled time-refinement screens, not physical validation tolerances. */
export function compareRegionalResponses(coarse: ResponseReceipt, fine: ResponseReceipt) {
  if (!coarse.completed || !fine.completed || coarse.case.heatSign !== fine.case.heatSign
    || coarse.case.minorMultiplier !== fine.case.minorMultiplier || coarse.case.dt_s !== 2 * fine.case.dt_s
    || fine.samples.length !== 2 * coarse.samples.length - 1) throw Error('Expected completed matching halved-step cases')
  const fields = [
    ['hotPressure_MPa', 1e6, 10], ['surfacePressure_MPa', 1e6, 10], ['level_m', 1, 1e-7],
    ['lowerVaporMass_kg', 1, 1e-6], ['upperFogMass_kg', 1, 1e-6],
    ['hotToLine_kg_s', 1, 1e-5], ['lineToPzr_kg_s', 1, 1e-5],
  ] as const
  return fields.map(([field, scale, floor]) => {
    const origin = fine.samples[0]![field]!
    let difference = 0, peakChange = 0
    for (let i = 0; i < coarse.samples.length; i++) {
      const a = coarse.samples[i]!, b = fine.samples[2 * i]!
      if (a.time_s !== b.time_s || !Number.isFinite(a[field]) || !Number.isFinite(b[field])) throw Error('Invalid common sample')
      difference = Math.max(difference, Math.abs(a[field]! - b[field]!) * scale)
    }
    for (const row of fine.samples) peakChange = Math.max(peakChange, Math.abs(row[field]! - origin) * scale)
    const limit = Math.max(floor, .02 * peakChange)
    return { field, units: scale === 1e6 ? 'Pa' : field.endsWith('_kg_s') ? 'kg/s' : field.endsWith('_kg') ? 'kg' : 'm',
      maximumCommonTimeDifference: difference, peakFineChange: peakChange, limit, passes: difference <= limit }
  })
}

if (import.meta.main) {
  const [wiki, python, name, step, minor = '1'] = Bun.argv.slice(2)
  if (!wiki || !python || !['hold', 'heating', 'cooling'].includes(name!) || !['0.5', '0.25'].includes(step!) || !['0.5', '1', '2'].includes(minor))
    throw Error('Usage: regional-support.ts <LD-01-directory> <research-python> <hold|heating|cooling> <0.5|0.25> [0.5|1|2 minor multiplier]')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceSha256: hash(await Bun.file(import.meta.path).text()), calculationSha256: hash(regionalSupportCalculation) }
  const paths = ['model/connected-primary-initialization.md', 'model/primary-hydraulic-basis.md',
    'systems/steam-power/cycle-basis.md', 'systems/reactor/fuel-construction.md',
    'systems/primary-coolant/pressure-and-inventory.md', 'systems/primary-coolant/surge-route.md']
  const docs = await Promise.all(paths.map(path => Bun.file(join(wiki, path)).text()))
  const input = { primary: await resolveInitializationInput(docs[0]!, docs[1]!, docs[2]!, python, parseConnectedFuel(docs[0]!, docs[3]!)),
    primaryDefinitions: primaryReferencePython, routeDefinitions: surgeRoutePython,
    route: resolveSurgeRoute(parseSurgeRoute(docs[5]!)), pzr: parsePressurizerBasis(docs[4]!),
    case: { name, dt_s: Number(step), heatSign: name === 'hold' ? 0 : name === 'heating' ? 1 : -1, minorMultiplier: Number(minor) } }
  const child = Bun.spawn([python, '-c', regionalSupportCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  console.log(JSON.stringify({ ...identity, inputSha256: hash(JSON.stringify(input)), ...JSON.parse(out) }, null, 2))
}

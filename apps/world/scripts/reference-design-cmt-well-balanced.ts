/** Offline 1-D actual-area Euler operator discriminator. Not the 2-D CMT or a live plant. */
import { createHash } from 'node:crypto'
import { acousticCoordinates, parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'
import { pressureRecoverySetup } from './reference-design-cmt-pressure-recovery.ts'

export function columnMesh(b: GeometryBasis, fine = false) {
  const g = tankGeometry(b), { zz } = acousticCoordinates(b, fine)
  const cells = zz.slice(1).map((z1, i) => {
    const z0 = zz[i]!, cuts = [...new Set([z0, z1, ...g.breaks([0, g.R, b.bodyOuterDiameter_m / 2, b.feedOuterDiameter_m / 2])])]
      .filter(z => z >= z0 && z <= z1).sort((a, b) => a - b)
    const pieces = cuts.slice(1).map((hi, j) => {
      const lo = cuts[j]!, mid = (lo + hi) / 2, h = (hi - lo) / 2
      const am = g.area(mid - h / 2), a0 = g.area(mid), ap = g.area(mid + h / 2)
      return { lo, hi, coefficients: [a0, ap - am, 2 * (ap + am - 2 * a0)] }
    }).filter(p => p.coefficients.some(x => x !== 0))
    return { volume_m3: g.volume(z0, z1), pieces }
  })
  const faceAreas_m2 = zz.map(z => g.area(z))
  const faces = cells.slice(1).map((_, i) => ({ left: i, right: i + 1, area_m2: faceAreas_m2[i + 1]!, sampleHeights_m: [zz[i + 1]!] }))
  return { cells, faces, elevations_m: zz, faceAreas_m2 }
}

export const wellBalancedSetup = pressureRecoverySetup + String.raw`
import time
diagnostics=dict(maximumStarEosPressureDiscrepancy_Pa=0.,maximumStarPressureJump_Pa=0.)

def compile_column(mesh):
    cells,S,_=prepared(mesh);V=np.array([c['V'] for c in cells]);zc=np.array([c['z'] for c in cells])
    variance=np.array([integral(c['c'],lambda z,A,Ap:(z-c['z'])**2*A,8)/c['V'] for c in cells])
    z=np.array(mesh['elevations_m']);area=np.array(mesh['faceAreas_m2']);n=len(cells)
    # Fixed geometric quadrature/stencils are compiled once, never thermodynamic state.
    def coefficients(M):
        mean=M/V;slopes=S@mean
        return mean,slopes,g*(M*zc+slopes*V*variance)
    def pressure(pc,r,s,x):return pc-g*(r*x+s*x*x/2)
    def recover_column(y):
        M,P,E=y.reshape(3,n)
        if not np.all(np.isfinite(y)) or min(M)<=0:raise ValueError('Nonpositive or nonfinite native state')
        rho,s,PE=coefficients(M);U=E-P*P/(2*M)-PE;pc=[];traces=[]
        for i,c in enumerate(cells):
            x=c['nodes']-zc[i];rr=rho[i]+s[i]*x;offset=-g*(rho[i]*x+s[i]*x*x/2)
            def energy(p):return sum(w*r*density_props(r,p+dp)[0] for w,r,dp in zip(c['weights'],rr,offset))
            if not energy(PLO)<=U[i]<=energy(PHI):raise ValueError('Column energy outside fixed pressure bracket')
            p=brentq(lambda pp:energy(pp)-U[i],PLO,PHI,xtol=1e-6,rtol=1e-14);pc.append(p)
            local=[]
            for zz in [z[i],z[i+1]]:
                xx=zz-zc[i];r=rho[i]+s[i]*xx;pp=pressure(p,rho[i],s[i],xx);u,T,du=density_props(r,pp)
                local.append(np.array([r,P[i]/M[i],pp,u,water.speed_sound()]))
            traces.append(local)
        return np.array(pc),np.array(traces),U,PE
    def initialize(kind):
        r0=props(p0,cold)[0];r1=props(p0,hot)[0]
        def density(zv):
            x=(zv-z[0])/(z[-1]-z[0])
            return r0+(r1-r0)*(x if kind=='affine' else x+.07*math.sin(2*math.pi*x))
        M=np.array([integral(c['c'],lambda zv,A,Ap:density(zv)*A,16) for c in cells]);rho,s,PE=coefficients(M)
        # This alone authors a continuous piecewise-discrete equilibrium. It is never called by rhs.
        E=np.zeros(n);right=p0
        for i in reversed(range(n)):
            c=cells[i];xr=z[i+1]-zc[i];pc=right+g*(rho[i]*xr+s[i]*xr*xr/2)
            E[i]=sum(w*r*density_props(r,pressure(pc,rho[i],s[i],zz-zc[i]))[0]
                for zz,w in zip(c['nodes'],c['weights']) for r in [rho[i]+s[i]*(zz-zc[i])])+PE[i]
            right=pressure(pc,rho[i],s[i],z[i]-zc[i])
        return np.r_[M,np.zeros(n),E]
    return dict(cells=cells,V=V,z=z,area=area,n=n,recover=recover_column,initialize=initialize)

def hllc(left,right):
    rL,vL,pL,uL,cL=left;rR,vR,pR,uR,cR=right
    EL=rL*(uL+vL*vL/2);ER=rR*(uR+vR*vR/2)
    UL=np.array([rL,rL*vL,EL]);UR=np.array([rR,rR*vR,ER])
    FL=np.array([rL*vL,rL*vL*vL+pL,(EL+pL)*vL]);FR=np.array([rR*vR,rR*vR*vR+pR,(ER+pR)*vR])
    SL=min(vL-cL,vR-cR);SR=max(vL+cL,vR+cR)
    if SL>=0:return FL
    if SR<=0:return FR
    SM=(pR-pL+rL*vL*(SL-vL)-rR*vR*(SR-vR))/(rL*(SL-vL)-rR*(SR-vR))
    if not SL<SM<SR:raise ValueError('HLLC wave ordering inadmissible')
    r,v,p,u,c=(left if SM>=0 else right);S=SL if SM>=0 else SR;U=UL if SM>=0 else UR;F=FL if SM>=0 else FR
    ps=p+r*(S-v)*(SM-v);rs=r*(S-v)/(S-SM);Es=((S-v)*U[2]-p*v+ps*SM)/(S-SM)
    if min(ps,rs)<=0:raise ValueError('HLLC star pressure/density inadmissible')
    # Rankine-Hugoniot energy, not an ideal-gas gamma closure. Check the selected star with the actual water EOS.
    water.update(DmassUmass_INPUTS,float(rs),float(Es/rs-SM*SM/2))
    if water.phase()!=CoolProp.iphase_liquid:raise ValueError('HLLC star left admitted liquid domain')
    diagnostics['maximumStarEosPressureDiscrepancy_Pa']=max(diagnostics['maximumStarEosPressureDiscrepancy_Pa'],abs(water.p()-ps))
    diagnostics['maximumStarPressureJump_Pa']=max(diagnostics['maximumStarPressureJump_Pa'],abs(pR-pL))
    return F+S*(np.array([rs,rs*SM,Es])-U)

def operator(o,y):
    n=o['n'];pc,traces,U,PE=o['recover'](y);flux=np.zeros((n+1,3))
    for j in range(1,n):
        flux[j]=hllc(traces[j-1,1],traces[j,0]);flux[j,2]+=g*o['z'][j]*flux[j,0];flux[j]*=o['area'][j]
    for j,cell,side in [(0,0,0),(n,n-1,1)]:
        inner=traces[cell,side];ghost=inner.copy();ghost[1]*=-1
        wall=hllc(ghost,inner) if j==0 else hllc(inner,ghost)
        # Impermeable stationary boundary: wall momentum reaction, zero mass and work by definition.
        flux[j,1]=wall[1]*o['area'][j]
    dy=-(flux[1:]-flux[:-1]).T
    # Exact current hydrostatic wall-plus-gravity source, including area jumps at closed hardware caps.
    dy[1]+=traces[:,1,2]*o['area'][1:]-traces[:,0,2]*o['area'][:-1]
    return dy.ravel(),dict(pc=pc,traces=traces,U=U,PE=PE,flux=flux)

def physical_source_check(o,y):
    n=o['n'];pc,tr,U,PE=o['recover'](y);M=y[:n];mean=M/o['V'];cells,S,_=prepared(dict(cells=[c['c'] for c in o['cells']],
        faces=[dict(left=i,right=i+1) for i in range(n-1)]));slopes=S@mean
    error=0.
    for i,c in enumerate(cells):
        def p(z):
            x=z-c['z'];return pc[i]-g*(mean[i]*x+slopes[i]*x*x/2)
        # Independent distributed wall reaction and gravity, plus exact area discontinuities/closed ledges.
        wall=integral(c['c'],lambda z,A,Ap:p(z)*Ap,16);pieces=c['c']['pieces']
        for a,b_ in zip(pieces,pieces[1:]):wall+=p(a['hi'])*(shape(b_,b_['lo'])[0]-shape(a,a['hi'])[0])
        lo,hi=pieces[0],pieces[-1]
        wall+=p(lo['lo'])*(shape(lo,lo['lo'])[0]-o['area'][i])-p(hi['hi'])*(shape(hi,hi['hi'])[0]-o['area'][i+1])
        source=wall-g*M[i];implemented=tr[i,1,2]*o['area'][i+1]-tr[i,0,2]*o['area'][i]
        error=max(error,abs(source-implemented))
    check('independent physical wall plus gravity source N',error,1e-5)
    return error

def cfl_limit(o,details):
    areaSum=o['area'][:-1]+o['area'][1:]
    if min(areaSum)<=0:raise ValueError('Isolated column cell has no physical open face')
    trace=details['traces'];speed=np.max(abs(trace[:,:,1])+trace[:,:,4],axis=1)
    return .15*min(o['V']/areaSum/speed)

def riemann_checks():
    def q(p,T,v):
        r,u=props(p,T);return np.array([r,v,p,u,water.speed_sound()])
    a=q(p0,cold,0);b_=q(p0,hot,0)
    check('general-water stationary contact mass flux',hllc(a,b_)[0],1e-10)
    check('general-water stationary contact pressure flux',hllc(a,b_)[1]-p0,1e-6)
    check('general-water stationary contact energy flux',hllc(a,b_)[2],1e-6)
    a=q(p0,cold,.1);r,v,p,u,c=a;expected=np.array([r*v,r*v*v+p,r*v*(u+v*v/2+p/r)])
    check('uniform moving-state Euler flux relative',max(abs(hllc(a,a)-expected)/np.maximum(abs(expected),1)),1e-10)
    b_=q(p0+100,hot,-.02);forward=hllc(a,b_);aa=a.copy();bb=b_.copy();aa[1]*=-1;bb[1]*=-1
    check('general-water oriented face reversal relative',max(abs(hllc(bb,aa)-forward*np.array([-1,1,-1]))/np.maximum(abs(forward),1)),1e-10)

def band_weights(o,lo,hi):
    def volume(c):
        result=0.
        for p in c['c']['pieces']:
            lower=max(lo,p['lo']);upper=min(hi,p['hi'])
            if upper<=lower:continue
            mid=(p['hi']+p['lo'])/2;h=(p['hi']-p['lo'])/2;x=(lower-mid)/h;y=(upper-mid)/h;a,b_,cc=p['coefficients']
            result+=h*(a*(y-x)+b_*(y*y-x*x)/2+cc*(y**3-x**3)/3)
        return result
    values=np.array([volume(c) for c in o['cells']])
    if min(values)<0 or sum(values)<=0:raise ValueError('Empty or invalid physical perturbation band')
    return values/sum(values)

def evolve(o,y0,duration,dt):
    n=o['n'];y=y0.copy();steps=math.ceil(duration/dt);dt=duration/steps;start=time.perf_counter()
    maxM=maxE=maxV=maxP=0.;pInitial=o['recover'](y0)[0];history=[];gross=0.;transfers=np.zeros((n+1,3))
    for k in range(steps):
        # SSPRK3 advances the native conservative state. No equilibrium or conservation reset.
        d,a=operator(o,y);q=y+dt*d;d2,b_=operator(o,q);q=.75*y+.25*(q+dt*d2);d3,c=operator(o,q)
        if dt>min(cfl_limit(o,a),cfl_limit(o,b_),cfl_limit(o,c))*(1+1e-12):raise ValueError('Evolving state violates declared explicit CFL')
        y=y/3+2*(q+dt*d3)/3
        gross+=dt/6*(sum(abs(a['flux'][1:-1,0]))+sum(abs(b_['flux'][1:-1,0]))+4*sum(abs(c['flux'][1:-1,0])))
        transfers+=dt/6*(a['flux']+b_['flux']+4*c['flux'])
        pc,traces,U,PE=o['recover'](y);M,P,E=y.reshape(3,n)
        maxM=max(maxM,abs(sum(M-y0[:n])));maxE=max(maxE,abs(sum(E-y0[2*n:])))
        maxV=max(maxV,max(abs(P/M)));maxP=max(maxP,max(abs(pc-pInitial)))
        if k in [0,steps//2,steps-1]:history.append(dict(t_s=(k+1)*dt,maximumVelocity_m_s=float(max(abs(P/M))),maximumPressureChange_Pa=float(max(abs(pc-pInitial))),kineticEnergy_J=float(sum(P*P/(2*M)))))
    check('closed column native mass conservation kg',maxM,1e-6);check('closed column total U+K+PE conservation J',maxE,.1)
    ledger=(y-y0).reshape(3,n)+(transfers[1:]-transfers[:-1]).T
    check('per-cell mass versus integrated common-face transfer kg',max(abs(ledger[0])),1e-6)
    check('per-cell total energy versus integrated common-face transfer J',max(abs(ledger[2])),.1)
    return dict(steps=steps,dt_s=dt,duration_s=duration,wall_s=time.perf_counter()-start,
        maximumMassResidual_kg=maxM,maximumTotalEnergyResidual_J=maxE,maximumVelocity_m_s=float(maxV),maximumPressureChange_Pa=float(maxP),
        maximumLocalMassLedgerResidual_kg=float(max(abs(ledger[0]))),maximumLocalEnergyLedgerResidual_J=float(max(abs(ledger[2]))),
        grossInternalFaceMass_kg=float(gross),history=history),y

def central_jacobian(rhs,t,delta,h,groups=None):
    # Grouped columns have structurally disjoint row support. None retains the dense independent comparator.
    size=len(delta);matrix=np.zeros((size,size))
    if groups is None:groups=[[(j,np.arange(size))] for j in range(size)]
    for group in groups:
        v=np.zeros(size)
        for j,rows in group:v[j]=h[j]
        difference=rhs(t,delta+v)-rhs(t,delta-v)
        for j,rows in group:matrix[rows,j]=difference[rows]/(2*h[j])
    return matrix

def implicit(o,y0,duration,tight=False,groups=None):
    n=o['n'];scales=np.r_[y0[:n],y0[:n],abs(y0[2*n:])];h=1e-8*scales
    tol=1e-9 if tight else 1e-7;atol=np.r_[np.full(n,1e-9),np.full(n,1e-9),np.full(n,1e-5)]*(.1 if tight else 1)
    rhsCalls=jacobianRhsCalls=0;rhsWall=jacobianWall=0.
    def rhs(t,delta):
        nonlocal rhsCalls,rhsWall
        start=time.perf_counter();value=operator(o,y0+delta)[0];rhsCalls+=1;rhsWall+=time.perf_counter()-start
        return value
    def jac(t,delta):
        nonlocal jacobianRhsCalls,jacobianWall
        before=rhsCalls;start=time.perf_counter()
        matrix=central_jacobian(rhs,t,delta,h,groups)
        jacobianRhsCalls+=rhsCalls-before;jacobianWall+=time.perf_counter()-start
        return matrix
    # Independent directional and half-step comparison uses resolvable native perturbations, not tiny zero-increment steps.
    delta=np.zeros(3*n);v=scales*np.sin(np.arange(3*n)+1)*1e-8
    fd=(rhs(0,v)-rhs(0,-v))/2;half=(rhs(0,v/2)-rhs(0,-v/2));Jv=jac(0,delta)@v
    derivativeDifference=float(np.linalg.norm(fd-Jv)/max(np.linalg.norm(fd),1));halfDifference=float(np.linalg.norm(fd-half)/max(np.linalg.norm(fd),1))
    check('native-scale Jacobian directional relative',derivativeDifference,.01)
    check('native-scale directional half-step relative',halfDifference,.01)
    rhsCalls=jacobianRhsCalls=0;rhsWall=jacobianWall=0.
    started=time.perf_counter();sol=solve_ivp(rhs,(0,duration),delta,method='Radau',jac=jac,rtol=tol,atol=atol,
        max_step=duration/(100 if tight else 50),dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    times=np.unique(np.r_[np.linspace(0,duration,101),data['duration_s']]);sample=sol.sol(times)
    maxM=maxE=maxV=maxP=0.;pInitial=o['recover'](y0)[0];history=[];minCfl=float('inf')
    for t,d in zip(times,sample.T):
        y=y0+d;derivative,view=operator(o,y);M,P,E=y.reshape(3,n);pc=view['pc'];minCfl=min(minCfl,cfl_limit(o,view))
        maxM=max(maxM,abs(sum(d[:n])));maxE=max(maxE,abs(sum(d[2*n:])))
        maxV=max(maxV,max(abs(P/M)));maxP=max(maxP,max(abs(pc-pInitial)))
        history.append(dict(t_s=float(t),pressureChange_Pa=(pc-pInitial).tolist(),velocity_m_s=(P/M).tolist(),
            kineticEnergy_J=float(sum(P*P/(2*M))),faceMassFlow_kg_s=view['flux'][1:-1,0].tolist()))
    for d in sol.y.T:
        y=y0+d;M,P,E=y.reshape(3,n);o['recover'](y)
        maxM=max(maxM,abs(sum(d[:n])));maxE=max(maxE,abs(sum(d[2*n:])))
    check('implicit column total native mass kg',maxM,1e-6);check('implicit column total U+K+PE J',maxE,.1)
    return dict(relativeTolerance=tol,absoluteTolerance=atol.tolist(),jacobianNativeRelativeStep=1e-8,
        jacobianGroups=3*n if groups is None else len(groups),
        jacobianDirectionalDifference=derivativeDifference,jacobianHalfStepDifference=halfDifference,
        acceptedSteps=len(sol.t)-1,functionCalls=sol.nfev,jacobianCalls=sol.njev,linearFactorizations=sol.nlu,wall_s=time.perf_counter()-started,
        actualRhsCallsIncludingJacobian=rhsCalls,jacobianRhsCalls=jacobianRhsCalls,rhsWall_s=rhsWall,jacobianWall_s=jacobianWall,
        minimumAcceptedStep_s=float(min(np.diff(sol.t))),maximumAcceptedStep_s=float(max(np.diff(sol.t))),
        duration_s=duration,maximumMassResidual_kg=maxM,maximumTotalEnergyResidual_J=maxE,
        maximumVelocity_m_s=float(maxV),maximumPressureChange_Pa=float(maxP),minimumSampledExplicitCfl_s=minCfl,
        history=history,overlapNativeState=(y0+sol.sol(data['duration_s'])).tolist(),finalNativeState=(y0+sol.y[:,-1]).tolist())
`
export const wellBalancedCalculation = wellBalancedSetup + String.raw`
riemann_checks();riemannDiagnostics=diagnostics.copy();diagnostics={k:0. for k in diagnostics};results=[];shortInitial=[];shortFinal=[];columns=[]
for mesh in data['meshes']:
    o=compile_column(mesh);n=o['n'];initial=o['initialize']('nonpolynomial');p,tr,U,PE=o['recover'](initial)
    d,details=operator(o,initial)
    dt=.9*cfl_limit(o,details);duration=data['duration_s'];physical_source_check(o,initial)
    print(str(n)+' cells dt '+str(dt),file=sys.stderr,flush=True)
    rest,restY=evolve(o,initial,duration,dt)
    check('compatible rest pressure drift Pa',rest['maximumPressureChange_Pa'],.1)
    check('compatible rest velocity m/s',rest['maximumVelocity_m_s'],1e-7)
    # Identical physical z bands on both meshes, not a mesh-dependent single-cell heat pulse.
    weights=band_weights(o,7,8);opposite=band_weights(o,9,10)
    heated=initial.copy();heated[2*n:]+=10000*(weights-opposite)
    cases=[]
    for factor in [1,.5]:
        print('heat '+str(n)+' dt factor '+str(factor),file=sys.stderr,flush=True)
        case,final=evolve(o,heated,duration,dt*factor);cases.append(dict(**case,finalNativeState=final.tolist()))
    temporalPressure=max(abs(o['recover'](np.array(cases[0]['finalNativeState']))[0]-o['recover'](np.array(cases[1]['finalNativeState']))[0]))
    check('short explicit halved-step pressure difference Pa',temporalPressure,.01)
    material=[];face=int(np.flatnonzero(o['z']==8.)[0]);physical_source_check(o,heated)
    for sign in [1,-1]:
        disturbed=initial.copy();donor,receiver=(face-1,face) if sign>0 else (face,face-1)
        r,v,p,u,c=tr[donor,1 if sign>0 else 0];dm=.005;de=dm*(u+p/r+g*o['z'][face])
        disturbed[donor]-=dm;disturbed[receiver]+=dm;disturbed[2*n+donor]-=de;disturbed[2*n+receiver]+=de
        check('initial signed material perturbation conserves mass kg',sum(disturbed[:n]-initial[:n]),1e-9)
        check('initial signed material perturbation conserves total energy J',sum(disturbed[2*n:]-initial[2*n:]),.1)
        physical_source_check(o,disturbed);case,final=evolve(o,disturbed,duration,dt)
        if case['grossInternalFaceMass_kg']<1e-9 or case['maximumVelocity_m_s']<1e-9:raise ValueError('Finite material disturbance was erased')
        material.append(dict(sign=sign,initialTransferredMass_kg=dm,initialTransferredTotalEnthalpy_J=de,**case))
    crossing=float(sum(np.diff(o['z'])/np.mean(tr[:,:,4],axis=1)))
    long=None;overlap=None
    if len(results)==0:
        print('implicit heat '+str(n)+' duration '+str(crossing),file=sys.stderr,flush=True);long=implicit(o,heated,crossing)
        explicit=np.array(cases[1]['finalNativeState']);implicitEnd=np.array(long['overlapNativeState'])
        overlap=dict(pressureDifference_Pa=float(max(abs(o['recover'](explicit)[0]-o['recover'](implicitEnd)[0]))),
            massDifference_kg=float(max(abs(explicit[:n]-implicitEnd[:n]))),totalEnergyDifference_J=float(max(abs(explicit[2*n:]-implicitEnd[2*n:]))))
        check('independent SSPRK3 Radau short overlap pressure Pa',overlap['pressureDifference_Pa'],.01)
        check('independent SSPRK3 Radau short overlap mass kg',overlap['massDifference_kg'],1e-7)
        check('independent SSPRK3 Radau short overlap total energy J',overlap['totalEnergyDifference_J'],.01)
    shortInitial.append(heated);shortFinal.append(np.array(cases[1]['finalNativeState']));columns.append(o)
    results.append(dict(cells=n,maximumInitialRhs=float(max(abs(d))),rest=rest,heat=cases,material=material,
        shortTemporalPressureDifference_Pa=float(temporalPressure),acousticCrossing_s=crossing,implicitHeat=long,shortExplicitImplicitOverlap=overlap))
coarse=(shortFinal[0]-shortInitial[0]).reshape(3,-1);fine=(shortFinal[1]-shortInitial[1]).reshape(3,-1);projected=fine.reshape(3,coarse.shape[1],2).sum(axis=2)
spatial=dict(maximumSameVolumeMassChangeDifference_kg=float(max(abs(coarse[0]-projected[0]))),
    maximumSameVolumeMomentumChangeDifference_kg_m_s=float(max(abs(coarse[1]-projected[1]))),maximumSameVolumeTotalEnergyChangeDifference_J=float(max(abs(coarse[2]-projected[2]))),
    interpretation='One 18/36-cell comparison of short heat-response increments on identical physical coarse volumes; not established spatial convergence.')
print(json.dumps(dict(scope='One-dimensional actual-area conservative Euler operator reference; not the two-dimensional CMT',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),results=results,checks=checks,
    riemannUnitDiagnostics=riemannDiagnostics,trajectoryDiagnostics=diagnostics,shortSpatialComparison=spatial,
    restrictedOperatorChecksPassed=True,longTimeAccuracyQualified=False,spatialConvergenceQualified=False,nonlinearCmtQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-well-balanced.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, mouth_m: tankGeometry(geometry).mouth, centerPressureInterval_Pa: [10e6, 20e6], duration_s: .00002,
    meshes: [columnMesh(geometry), columnMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const files = ['reference-design-cmt-pressure-recovery.ts', 'reference-design-cmt-reconstruction.ts', 'reference-design-cmt-hydrostatic.ts', 'reference-design-cmt-acoustics.ts', 'reference-design-cmt-geometry.ts']
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    sharedSourceHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await Bun.file(new URL(file, import.meta.url)).text())]))), calculationHash: hash(wellBalancedCalculation) }
  const child = Bun.spawn([python, '-c', wellBalancedCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT well-balanced operator reference failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}

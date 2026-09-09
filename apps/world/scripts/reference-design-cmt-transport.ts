/** Offline continuous signed-donor discriminator; not a nonlinear or production CMT model. */
import { createHash } from 'node:crypto'
import { acousticMesh, acousticSetup, parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis } from './reference-design-cmt-geometry.ts'

export const transportCalculation = acousticSetup + String.raw`
from scipy.integrate import solve_ivp
from scipy.sparse import csr_matrix,diags,bmat
import time

def continuous(o,tolerance,reverse=False,uniform=False):
    N=o['N'];nx=len(o['A']);np_=len(o['ports']);A=csr_matrix(o['A']);B=csr_matrix(o['Btotal'])
    F=csr_matrix(rho*o['Fs']);Fp=F[o['nf']:];ne=F.shape[0]
    left=np.argmax(o['Btotal'],axis=0);right=np.argmin(o['Btotal'],axis=0)
    x0=initial(o,reverse);M0=rho*o['V'];Md=csr_matrix((rho*np.sqrt(o['C']),(np.arange(N),np.arange(N))),shape=(N,nx))
    initialMass=M0+Md@x0;initialFraction=np.ones(N) if uniform else np.eye(N)[o['ext']]
    Z0=initialMass*initialFraction
    def state(y):
        x=y[:nx];M=M0+Md@x;Z=Z0+y[nx:nx+N];q=F@x
        if np.min(M)<=0:raise ValueError('Nonpositive material inventory')
        donor=np.where(q>=0,left,right);c=Z[donor]/M[donor]
        return x,M,Z,q,donor,c
    def rhs(t,y):
        x,M,Z,q,donor,c=state(y);ports=q[o['nf']:]
        return np.r_[A@x,-B@(q*c),np.maximum(ports,0),np.maximum(-ports,0)]
    def jac(t,y):
        x,M,Z,q,donor,c=state(y);D=csr_matrix((np.ones(ne),(np.arange(ne),donor)),shape=(ne,N))
        Jx=-B@(diags(c)@F-diags(q*c/M[donor])@D@Md)
        Jz=-B@diags(q/M[donor])@D;ports=q[o['nf']:]
        return bmat([[A,None,None,None],[Jx,Jz,None,None],
          [diags((ports>0).astype(float))@Fp,None,csr_matrix((np_,np_)),None],
          [-diags((ports<0).astype(float))@Fp,None,None,csr_matrix((np_,np_))]],format='csc')
    y0=np.r_[x0,np.zeros(N+2*np_)];atol=np.r_[np.full(nx,tolerance*1e-5),np.full(N+2*np_,tolerance*1e-3)]
    # Analytic Jacobian is checked away from the piecewise-smooth donor switch.
    probe=y0.copy();probe[:nx]=expm(o['A']*b['steps_s'][0])@x0
    # A radial acoustic perturbation preserves every face's donor branch, including tiny tails.
    direction=np.sin(np.arange(len(y0))+1)*1e-3;direction[:nx]=probe[:nx]*.1;eps=1e-4
    fd=(rhs(0,probe+eps*direction)-rhs(0,probe-eps*direction))/(2*eps);jd=jac(0,probe)@direction
    check('continuous sparse Jacobian directional derivative',np.linalg.norm(fd-jd)/max(1,np.linalg.norm(jd)),1e-7)
    start=time.perf_counter()
    sol=solve_ivp(rhs,(0,b['duration_s']),y0,method='Radau',jac=jac,rtol=tolerance,atol=atol,dense_output=True)
    elapsed=time.perf_counter()-start
    if not sol.success:raise ValueError(sol.message)
    # Independent exact acoustic history at frozen samples, not adaptive accepted-time-only comparison.
    sampleDt=b['steps_s'][0];times=np.linspace(0,b['duration_s'],round(b['duration_s']/sampleDt)+1)
    E=expm(o['A']*sampleDt);exact=x0.copy();samples=sol.sol(times);scale=np.linalg.norm(x0)
    historyError=0.;massError=tagError=uniformError=0.;minTag=1.;maxTag=0.;history=[];tagHistory=[]
    for k,t in enumerate(times):
        x,M,Z,q,donor,c=state(samples[:,k]);fractions=Z/M
        historyError=max(historyError,float(np.linalg.norm(x-exact)/scale))
        massError=max(massError,abs(float(np.sum(M-initialMass))));tagError=max(tagError,abs(float(np.sum(samples[nx:nx+N,k]))))
        minTag=min(minTag,float(min(fractions)));maxTag=max(maxTag,float(max(fractions)))
        if uniform:uniformError=max(uniformError,float(max(abs(Z-M))))
        history.append(dict(t_s=float(t),tankOriginMass_kg=float(sum(Z[:o['n']])),dviOriginMass_kg=float(Z[o['dvi']])))
        tagHistory.append(Z.tolist())
        exact=E@exact
    # Bounds also checked at every accepted integration endpoint; no clipping or conservation correction.
    for y in sol.y.T:
        x,M,Z,q,donor,c=state(y);minTag=min(minTag,float(min(Z/M)));maxTag=max(maxTag,float(max(Z/M)))
    check('continuous total tag conservation',tagError,2e-9)
    check('continuous total linearized material mass',massError,2e-8)
    check('continuous lower tracer bound',max(0,-minTag),1e-10)
    check('continuous upper tracer bound',max(0,maxTag-1),1e-10)
    if uniform:check('continuous uniform material preserved',uniformError,2e-9)
    final=sol.y[:,-1];forward=final[nx+N:nx+N+np_];backward=final[nx+N+np_:]
    exactNet=rho*o['Fs'][o['nf']:]@(propagator(o['A'],b['duration_s'])[1]@x0)
    check('continuous signed port integral versus independent exact integral',max(abs(forward-backward-exactNet)),2e-9)
    return dict(relativeTolerance=tolerance,reverse=reverse,uniform=uniform,wall_s=elapsed,
      acceptedSteps=len(sol.t)-1,functionCalls=sol.nfev,jacobianCalls=sol.njev,linearFactorizations=sol.nlu,
      acousticMaximumSampledHistoryError=historyError,acousticScreenPassed=historyError<=b['maximumMidpointRelativeError'],
      maximumTagResidual_kg=tagError,maximumTotalMaterialResidual_kg=massError,
      maximumUniformMaterialResidual_kg=uniformError if uniform else None,
      minimumTagFraction=minTag,maximumTagFraction=maxTag,
      finalTracerInventory_kg=(Z0+final[nx:nx+N]).tolist(),
      forwardPortMass_kg=forward.tolist(),reversePortMass_kg=backward.tolist(),
      grossPortMass_kg=(forward+backward).tolist(),history=history,tagHistory_kg=tagHistory,
      grossHistory_kg=(samples[nx+N:nx+N+np_]+samples[nx+N+np_:]).T.tolist())

def reversal_control():
    # Two finite perfectly mixed stores. +0.25 kg transfer then -0.25 kg, explicitly split at the known reversal.
    # Exact sequence leaves 0.2 kg origin tag in receiver although net transfer is zero.
    def f(sign):
        def rhs(t,y):
            m=np.array([1.,1.])+np.array([-1.,1.])*y[0];z=np.array([1.,0.])+np.array([-1.,1.])*y[1]
            return np.array([sign,sign*z[0 if sign>0 else 1]/m[0 if sign>0 else 1]])
        return rhs
    forward=solve_ivp(f(1),(0,.25),[0.,0.],method='Radau',rtol=1e-10,atol=1e-13)
    reverse=solve_ivp(f(-1),(.25,.5),forward.y[:,-1],method='Radau',rtol=1e-10,atol=1e-13)
    if not forward.success or not reverse.success:raise ValueError('Analytic reversal reference failed')
    final=reverse.y[:,-1];check('zero-net analytic donor reversal',final[0],1e-12)
    check('nonzero gross-exchange analytic origin transfer',final[1]-.2,1e-10)
    return dict(netMass_kg=float(final[0]),grossMass_kg=.5,receiverOriginMass_kg=float(final[1]),exactReceiverOriginMass_kg=.2,
      intervalNetAlgorithmReceiverOriginMass_kg=0)

results=[]
for mesh in data['meshes']:
    o=operators(mesh);cases=[continuous(o,1e-7),continuous(o,1e-9),continuous(o,1e-9,True),continuous(o,1e-9,uniform=True)]
    diff=float(np.max(abs(np.array(cases[0]['tagHistory_kg'])-np.array(cases[1]['tagHistory_kg']))))
    grossDiff=float(np.max(abs(np.array(cases[0]['grossHistory_kg'])-np.array(cases[1]['grossHistory_kg']))))
    check('continuous gross forward/reverse source symmetry',max(abs(np.array(cases[1]['forwardPortMass_kg'])-np.array(cases[2]['reversePortMass_kg']))),2e-9)
    previous=run(o,b['steps_s'][1]);bias=max(abs(np.array(previous['tracerInventory_kg'])-np.array(cases[1]['finalTracerInventory_kg'])))
    grossShortfall=max(np.array(cases[1]['grossPortMass_kg'])-np.array(previous['sumAbsoluteIntervalPortMass_kg']))
    for case in cases:
        del case['tagHistory_kg'];del case['grossHistory_kg']
    results.append(dict(cells=o['n'],acousticUnknowns=len(o['A']),coupledUnknowns=len(o['A'])+o['N']+2*len(o['ports']),
      cases=cases,tagToleranceDifference_kg=float(diff),tagScreenPassed=bool(diff<=b['maximumTagDifference_kg']),
      grossToleranceDifference_kg=float(grossDiff),grossScreenPassed=bool(grossDiff<=b['maximumTagDifference_kg']),
      previousIntervalNetTracerDifference_kg=float(bias),
      previousIntervalNetMaximumGrossShortfall_kg=float(grossShortfall)))
print(json.dumps(dict(scope='Adaptive coupled linear acoustic/continuous signed-origin transport; no nonlinear thermal CMT qualification',
  versions=dict(numpy=np.__version__,scipy=scipy.__version__,CoolProp=CoolProp.__version__),reversalControl=reversal_control(),
  meshes=results,checks=checks,nonlinearThermalTransportImplemented=False,physicalPortInertiaQualified=False,checksPassed=True),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-transport.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, meshes: [acousticMesh(geometry), acousticMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    acousticSourceHash: hash(await Bun.file(new URL('./reference-design-cmt-acoustics.ts', import.meta.url)).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()), calculationHash: hash(transportCalculation) }
  const child = Bun.spawn([python, '-c', transportCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT continuous transport reference failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}

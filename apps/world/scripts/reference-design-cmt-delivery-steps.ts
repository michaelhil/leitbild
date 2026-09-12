/** Bounded observation of documented IDA internal-step returns. No solver or physics change. */
import { createHash } from 'node:crypto'
import { deliveryIdaSetup } from './reference-design-cmt-delivery-ida.ts'

export const bindingProvenancePython = String.raw`
import hashlib,pathlib,re
def binding_provenance(module_file):
    binary=pathlib.Path(module_file);source=binary.parent/'_cy_ida.pyx'
    candidates=[]
    # Wheel layouts differ; these are discovered package artifacts, not proof of dynamic linkage.
    for directory in [binary.parent/'.dylibs',binary.parent/'.libs',binary.parent,binary.parent.parent/'sksundae.libs']:
        if directory.is_dir():
            for candidate in directory.iterdir():
                if candidate.is_file() and re.match(r'^(?:lib)?sundials_ida(?:[-.]|$)',candidate.name):
                    candidates.append(candidate)
    return dict(module=str(binary),binaryHash=hashlib.sha256(binary.read_bytes()).hexdigest(),
      sourceHash=hashlib.sha256(source.read_bytes()).hexdigest() if source.is_file() else None,
      bundledIdaLibraryCandidates=[dict(path=str(p),sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(set(candidates))],
      libraryIdentityConvention='Discovered bundled IDA files only; empty means unavailable, not a substituted or inferred identity')
`
export const deliveryStepsCalculation = deliveryIdaSetup + bindingProvenancePython + String.raw`
import sksundae._cy_ida as ida_binding
bindingIdentity=binding_provenance(ida_binding.__file__)
started=time.perf_counter();calls=probeCalls=0;inProbe=False;jacobians=[];rows=[];failure=None
x0=initial(15.2e6);Y0,cv,pv,r,receiver,pb,pt,tb=port_views(x0)
va=boundary_initial(pt,tb,0.,'valve',True);ca=boundary_initial(receiver,pb,1.,'check',True)
base=np.r_[Y0,x0[pressureIndex],va,ca,0.,0.];mode=(0.,True,False,True)
atol=np.r_[np.full(nc,1e-9),np.full(nc,1e-8),np.full(nc,1e-3),np.full(np_,1e-9),np.full(np_,1e-8),np.full(np_,1e-3),1e-9,1e-3,
 np.full(N+1,.1),1e-8,np.tile([1e-8,.1,.1,1e-9],2),1e-8,1e-8]
yp0=np.zeros(totalSize);_,d,_,v=ida_evaluate(base,*mode);yp0[:nativeSize]=d;yp0[-2]=v['kineticChainRate_W'];yp0[-1]=v['wallDissipation_W']
initialResidual=ida_residual(base,yp0,*mode);lastTrial=0.
def residual(t,y,yp,out):
    global calls,probeCalls,lastTrial
    calls+=1;lastTrial=float(t)
    if inProbe:probeCalls+=1
    if time.perf_counter()-started>60:raise RuntimeError('Predeclared60s internal-step diagnostic budget exhausted')
    out[:]=ida_residual(base+y,yp,*mode)
def jacobian(t,y,yp,rr,cj,J):
    global inProbe
    record=dict(t_s=float(t),cj_per_s=float(cj),callsBefore=calls,probesBefore=probeCalls);jacobians.append(record)
    def probe(step):
        out=np.empty(totalSize);residual(t,y+step,yp,out);return out
    inProbe=True
    try:J[:]=ida_jacobian(base+y,cj,probe)
    finally:
        inProbe=False;record.update(callsAfter=calls,probesAfter=probeCalls)
def event(t,y,yp,out):
    _,_,_,view=ida_evaluate(base+y,*mode);out[0]=view['checkDrive_Pa']+b['checkCrack_Pa']
event.direction=[-1];event.terminal=[True]
solver=IDA(residual,algebraic_idx=list(range(nativeSize,totalSize-2)),rtol=1e-4,atol=atol,max_step=.01,
 jacfn=jacobian,max_num_steps=10000,eventsfn=event,num_events=1)
try:
    result=solver.init_step(0.,np.zeros(totalSize),yp0)
    if not result.success:raise ValueError(result.message)
    for i in range(20):
        result=solver.step(.025,method='onestep',tstop=.025)
        if not result.success:raise ValueError(dict(status=int(result.status),message=str(result.message)))
        native=base[:nativeSize]+result.y[:nativeSize];Y,d,br,view=ida_evaluate(base+result.y,*mode)
        if not all(np.all(np.isfinite(a)) for a in [native,result.y,result.yp,Y,d,br]):
            raise ValueError('Returned internal state has nonfinite values')
        groups=[np.r_[np.arange(nc),np.arange(3*nc,3*nc+np_),nativeSize-2].astype(int),
          np.r_[np.arange(nc,2*nc),np.arange(3*nc+np_,3*nc+2*np_)].astype(int),np.r_[energyIndex,nativeSize-1]]
        rates=np.array(result.yp[:nativeSize])-d;rateMax=[float(max(abs(rates[ii]))) for ii in groups]
        mass=float(sum(native[:nc]-Y0[:nc])+sum(native[3*nc:3*nc+np_]-Y0[3*nc:3*nc+np_])+native[-2]-Y0[-2])
        energy=float(sum(native[2*nc:3*nc]-Y0[2*nc:3*nc])+sum(native[3*nc+2*np_:3*N]-Y0[3*nc+2*np_:3*N])+native[-1]-Y0[-1])
        storage=[float(max(abs(native[energyIndex]-Y[energyIndex]))),abs(float(native[-2]-Y[-2])),abs(float(native[-1]-Y[-1]))]
        row=dict(returnedInternalTime_s=float(result.t),status=int(result.status),nfev=int(result.nfev),njev=int(result.njev),
          residualCalls=calls,probeCalls=probeCalls,maximumVelocity_m_s=view['maximumVelocity_m_s'],
          nativeMassLedger_kg=mass,nativeEnergyLedger_J=energy,storageResidual_fieldE_dviM_dviE=storage,
          boundaryPressureResidual_Pa=float(max(abs(br[[1,2,5,6]]))),boundaryFlowResidual_kg_s=float(max(abs(br[[0,4]]))),
          boundaryEnthalpyResidual_J_kg=float(max(abs(br[[3,7]]))),
          returnedRateResidual_M_P_E_per_s=rateMax,maxStepScaledEquationDefect=[a*.01 for a in rateMax],
          nativeState=native.tolist(),solverOffset=result.y.tolist(),returnedDerivative=result.yp.tolist(),admitted=False,
          statistics=solver.statistics() if hasattr(solver,'statistics') else None)
        rows.append(row)
        if result.status==2:raise ValueError('Returned root event; fixed-mode continuation is not authorized')
        if abs(mass)>1e-6 or abs(energy)>.1 or any(a>g for a,g in zip(storage,[.01,1e-7,.01])):
            raise ValueError('Returned internal state violates retained native/storage gate')
        if row['boundaryPressureResidual_Pa']>.01 or row['boundaryFlowResidual_kg_s']>1e-8 or row['boundaryEnthalpyResidual_J_kg']>1e-5:
            raise ValueError('Returned internal state violates retained boundary gate')
        if any(a*.01>g for a,g in zip(rateMax,[1e-7,1e-5,.01])):
            raise ValueError('Returned internal state violates retained equation-defect indicator')
        if view['maximumVelocity_m_s']>1e-8:raise ValueError('Returned internal state violates retained rest-motion screen')
        row['admitted']=True
        print(json.dumps(dict(phase='internal-step',step=row),allow_nan=False),flush=True)
        if result.t>=.025:break
except (ValueError,RuntimeError) as error:failure=str(error)
print(json.dumps(dict(phase='summary',initialMaximumResidual=float(max(abs(initialResidual))),
 failure=failure,returnedStates=rows,jacobians=jacobians,lastCallbackTrialTime_s=lastTrial,
 calls=calls,probeCalls=probeCalls,wall_s=time.perf_counter()-started,
 unavailableStatistics=[] if hasattr(solver,'statistics') else ['error-test failures','nonlinear convergence failures','BDF order'],
 binding=bindingIdentity,
 physicalEquationsUnchanged=True,halfSecondTrajectoryQualified=False,
 versions=dict(sksundae=sksundae.__version__,CoolProp=CoolProp.__version__)),allow_nan=False),flush=True)
`

if (import.meta.main) {
  const [receipt, python, output] = Bun.argv.slice(2)
  if (!receipt || !python || !output || Bun.argv.length !== 5) throw Error('Usage: cmt-delivery-steps.ts delivery.json research-python output.json')
  const old = await Bun.file(receipt).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(deliveryStepsCalculation), inputHash: hash(input) }
  const child = Bun.spawn([python, '-c', deliveryStepsCalculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const records: unknown[] = []
  let pending = ''
  for await (const chunk of child.stdout) {
    pending += new TextDecoder().decode(chunk)
    let split: number
    while ((split = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, split); pending = pending.slice(split + 1)
      if (!line.trim()) continue
      const record = JSON.parse(line); records.push(record)
      await Bun.write(output, JSON.stringify({ ...identity, records }, null, 2))
      console.log(record.phase === 'internal-step' ? { t: record.step.returnedInternalTime_s, nfev: record.step.nfev, njev: record.step.njev } : { failure: record.failure, calls: record.calls })
    }
  }
  if (pending.trim() || await child.exited !== 0) throw Error('Internal-step diagnostic did not finish cleanly; completed records retained')
}

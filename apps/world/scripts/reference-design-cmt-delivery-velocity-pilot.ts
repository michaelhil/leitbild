/** Single stock-IDA closed-rest admission run after the frozen velocity-budget static gate. */
import { createHash } from 'node:crypto'
import { velocityBudgetSetup, velocityOverlapCalculation } from './reference-design-cmt-delivery-velocity-budget.ts'
import { bindingProvenancePython } from './reference-design-cmt-delivery-steps.ts'

export function requireVelocityOverlap(gate: unknown, expectedInputHash: string) {
  if (typeof gate !== 'object' || gate === null) throw Error('Missing static admission receipt')
  const value = gate as Record<string, unknown>
  const expectedCalculation = createHash('sha256').update(velocityOverlapCalculation).digest('hex')
  if (value.inputHash !== expectedInputHash || value.calculationHash !== expectedCalculation || value.overlapAccepted !== true) {
    throw Error('Current static admission gate not satisfied')
  }
}

export const velocityPilotCalculation = velocityBudgetSetup + bindingProvenancePython + String.raw`
import sksundae._cy_ida as binding
identity=binding_provenance(binding.__file__)
started=time.perf_counter();calls=jacCalls=0;lastTrial=0.;rows=[];failure=None
base,yp0,mode=fixture(15.2e6,0.,True,False);atol=velocity_atol(base[:nativeSize])
initialK=float(sum(base[momentumI]**2/(2*base[massI])))
initialResidual=ida_residual(base,yp0,*mode)
if max(abs(initialResidual))>1e-7:raise ValueError('Original initial residual admission failed')
def residual(t,y,yp,out):
    global calls,lastTrial
    calls+=1;lastTrial=float(t)
    if time.perf_counter()-started>60:raise RuntimeError('Frozen 60 s velocity-budget pilot ceiling exhausted')
    out[:]=ida_residual(base+y,yp,*mode)
def jacobian(t,y,yp,rr,cj,J):
    global jacCalls
    jacCalls+=1
    def probe(step):
        out=np.empty(totalSize);residual(t,y+step,yp,out);return out
    J[:]=ida_jacobian(base+y,cj,probe)
def event(t,y,yp,out):
    _,_,_,view=ida_evaluate(base+y,*mode);out[0]=view['checkDrive_Pa']+b['checkCrack_Pa']
event.direction=[-1];event.terminal=[True]
solver=IDA(residual,algebraic_idx=list(range(nativeSize,totalSize-2)),rtol=1e-4,atol=atol,max_step=.01,
 jacfn=jacobian,max_num_steps=10000,eventsfn=event,num_events=1)
try:
    result=solver.init_step(0.,np.zeros(totalSize),yp0)
    if not result.success:raise ValueError(str(result.message))
    for i in range(200):
        result=solver.step(.025,method='onestep',tstop=.025)
        if not result.success:raise ValueError(dict(status=int(result.status),message=str(result.message)))
        all_=base+result.y;native=all_[:nativeSize];Y,d,br,v=ida_evaluate(all_,*mode)
        if not all(np.all(np.isfinite(a)) for a in [native,result.y,result.yp,Y,d,br]):raise ValueError('Nonfinite returned state')
        mass=float(sum(native[massI]-base[massI])+native[-2]-base[nativeSize-2])
        energy=float(sum(native[energyIndex]-base[energyIndex])+native[-1]-base[nativeSize-1])
        storage=[float(max(abs(native[energyIndex]-Y[energyIndex]))),abs(float(native[-2]-Y[-2])),abs(float(native[-1]-Y[-1]))]
        rates=np.array(result.yp[:nativeSize])-d
        rateMax=[float(max(abs(rates[ii]))) for ii in [np.r_[massI,nativeSize-2],momentumI,np.r_[energyIndex,nativeSize-1]]]
        row=dict(t_s=float(result.t),status=int(result.status),nfev=int(result.nfev),njev=int(result.njev),
          nativeMassLedger_kg=mass,nativeEnergyLedger_J=energy,storageResidual_fieldE_dviM_dviE=storage,
          boundaryPressureResidual_Pa=float(max(abs(br[[1,2,5,6]]))),boundaryFlowResidual_kg_s=float(max(abs(br[[0,4]]))),
          boundaryEnthalpyResidual_J_kg=float(max(abs(br[[3,7]]))),maximumVelocity_m_s=v['maximumVelocity_m_s'],
          returnedRateResidual_M_P_E_per_s=rateMax,kineticEnergy_J=v['kineticEnergy_J'],
          kineticChainDefect_J=float(v['kineticEnergy_J']-initialK-result.y[-2]),
          initialToCurrentMassRatio=(base[massI]/native[massI]).tolist(),nativeState=native.tolist(),
          solverOffset=result.y.tolist(),returnedDerivative=result.yp.tolist(),admitted=False)
        rows.append(row)
        if result.status==2:raise ValueError('Terminal check event returned; continuation not authorized')
        if abs(mass)>1e-6 or abs(energy)>.1 or any(a>g for a,g in zip(storage,[.01,1e-7,.01])):raise ValueError('Original native/storage gate failed')
        if row['boundaryPressureResidual_Pa']>.01 or row['boundaryFlowResidual_kg_s']>1e-8 or row['boundaryEnthalpyResidual_J_kg']>1e-5:raise ValueError('Original boundary gate failed')
        if any(a*.01>g for a,g in zip(rateMax,[1e-7,1e-5,.01])):raise ValueError('Original returned-equation gate failed')
        if row['maximumVelocity_m_s']>1e-8:raise ValueError('Original rest-motion gate failed')
        row['admitted']=True
        print(json.dumps(dict(phase='accepted-step',state=row),allow_nan=False),flush=True)
        if result.t>=.025:break
    else:failure='Frozen 200 accepted-step ceiling exhausted'
except (ValueError,RuntimeError) as error:failure=str(error)
print(json.dumps(dict(phase='decision',scope='One closed-rest 0.025 s realization admission, not delivery or temporal qualification',
 completed=bool(rows and rows[-1]['admitted'] and rows[-1]['t_s']>=.025 and failure is None),failure=failure,
 acceptedSteps=sum(r['admitted'] for r in rows),lastAcceptedTime_s=next((r['t_s'] for r in reversed(rows) if r['admitted']),0.),
 lastCallbackTrialTime_s=lastTrial,lastReturnedState=rows[-1] if rows else None,calls=calls,jacobians=jacCalls,wall_s=time.perf_counter()-started,
 momentumVelocityAtol_m_s=1e-10,atol=atol.tolist(),binding=identity,
 halfSecondDeliveryQualified=False,temporalComparisonQualified=False,checkEventContinuationQualified=False),allow_nan=False),flush=True)
`
if (import.meta.main) {
  const [receipt, overlap, python, output] = Bun.argv.slice(2)
  if (!receipt || !overlap || !python || !output || Bun.argv.length !== 6) throw Error('Usage: velocity-pilot.ts delivery.json admitted-overlap.json research-python output.json')
  const old = await Bun.file(receipt).json(), gate = await Bun.file(overlap).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  requireVelocityOverlap(gate, hash(input))
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(velocityPilotCalculation), inputHash: hash(input), overlapHash: hash(await Bun.file(overlap).text()) }
  const child = Bun.spawn([python, '-c', velocityPilotCalculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const records: unknown[] = []; let pending = ''
  for await (const chunk of child.stdout) {
    pending += new TextDecoder().decode(chunk)
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break
      const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line.trim()) continue
      const record = JSON.parse(line); records.push(record)
      await Bun.write(output, JSON.stringify({ ...identity, records }, null, 2))
      console.log(record.phase === 'accepted-step' ? { t: record.state.t_s } : record)
    }
  }
  if (await child.exited !== 0 || pending.trim()) throw Error('Pilot stopped without final decision; completed records retained')
}

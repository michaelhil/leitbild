/** One observable-based momentum budget on the unchanged CMT residual; bounded admission, not a tolerance sweep. */
import { createHash } from 'node:crypto'
import { deliveryIdaSetup } from './reference-design-cmt-delivery-ida.ts'

export const velocityBudgetSetup = deliveryIdaSetup + String.raw`
massI=np.r_[np.arange(nc),np.arange(3*nc,3*nc+np_)].astype(int)
momentumI=np.r_[np.arange(nc,2*nc),np.arange(3*nc+np_,3*nc+2*np_)].astype(int)
originalAtol=np.r_[np.full(nc,1e-9),np.full(nc,1e-8),np.full(nc,1e-3),np.full(np_,1e-9),np.full(np_,1e-8),np.full(np_,1e-3),1e-9,1e-3,
 np.full(N+1,.1),1e-8,np.tile([1e-8,.1,.1,1e-9],2),1e-8,1e-8]
def velocity_atol(native):
    result=originalAtol.copy();result[momentumI]=native[massI]*1e-10
    return result
def fixture(pressure,moving,closed,failed):
    x=initial(pressure);x[nc:2*nc]=moving*x[:nc];x[3*nc+np_:3*nc+2*np_]=moving*x[3*nc:3*nc+np_]
    Y,cv,pv,r,receiver,pb,pt,tb=port_views(x);alpha=0. if closed else .25
    drive=receiver['p']-pb['p']+pb['rho']*pb['c']*pb['v'];seated=not failed and drive>=-b['checkCrack_Pa']
    va=boundary_initial(pt,tb,alpha,'valve',closed);ca=boundary_initial(receiver,pb,1.,'failed-open' if failed else 'check',seated)
    full=np.r_[Y,x[pressureIndex],va,ca,0.,0.];mode=(alpha,seated,failed,closed)
    _,d,_,v=ida_evaluate(full,*mode);yp=np.r_[d,np.zeros(pressureCount+8),v['kineticChainRate_W'],v['wallDissipation_W']]
    return full,yp,mode
`
export const velocityOverlapCalculation = velocityBudgetSetup + String.raw`
started=time.perf_counter();rows=[];failures=[]
for name,p,v,closed,failed in [('cold-rest',15.2e6,0.,True,False),('moving-forward',15.2e6,-.01,False,False),('hot-receiver-reverse',15.21e6,.01,False,True)]:
    full,yp,mode=fixture(p,v,closed,failed);atol=velocity_atol(full[:nativeSize]);f0=ida_residual(full,yp,*mode)
    def fun(delta):
        if time.perf_counter()-started>90:raise RuntimeError('Frozen 90 s static admission budget exhausted')
        return ida_residual(full+delta,yp,*mode)
    J=ida_jacobian(full,0.,fun)
    gates=np.r_[np.full(nc,1e-5),np.full(nc,.001),np.full(nc,1e-4),np.full(np_,1e-5),np.full(np_,.001),np.full(np_,1e-4),1e-5,1e-4,
      np.full(N,1e-6),1e-7,1e-6,np.tile([1e-6,1e-6,1e-6,1e-5],2),1e-6,1e-6]
    if closed:gates[-10]=1e-8
    if mode[1]:gates[-6]=1e-8
    rowUnits=np.r_[nativeScales,np.full(N,1e4),1.,1e4,np.tile([1e4,1e4,1e4,1.],2),1.,1.]
    if closed:rowUnits[-10]=1.
    if mode[1]:rowUnits[-6]=1.
    directions=[];masses=full[massI];velocities=full[momentumI]/masses
    trial=make_trial(full[:nativeSize],full[nativeSize:nativeSize+pressureCount])
    ep=np.r_[forward(cm,*trial[:3*nc].reshape(3,nc))[2],forward(pm,*trial[3*nc:3*N].reshape(3,np_))[2]]
    for kind in ['momentum','mass-momentum','pressure-energy']:
        delta=np.zeros(totalSize);pattern=np.sin(np.arange(N)+.7)
        if kind in ['momentum','mass-momentum']:
            delta[momentumI]=atol[momentumI]*pattern
            if kind=='mass-momentum':
                delta[massI]=originalAtol[massI]*np.cos(np.arange(N)+.4)
                delta[momentumI]+=velocities*delta[massI]
        else:
            delta[nativeSize:nativeSize+N]=.1*pattern;delta[energyIndex]=ep*delta[nativeSize:nativeSize+N]
        probes=[]
        for factor in [1.,.5]:
            step=delta*factor;plus=full+step;minus=full-step;actual=(plus-minus)/2
            ids=np.flatnonzero(step);loss=float(max(abs((actual[ids]-step[ids])/step[ids])))
            fp=fun(step);fm=fun(-step);observed=(fp-fm)/2;expected=J@actual;defect=observed-expected
            if not np.all(np.isfinite(np.r_[fp,fm,actual])):raise ValueError('Nonfinite static probe')
            scaled=float(max(abs(defect/gates)))
            velocityChange=(plus[momentumI]/plus[massI]-minus[momentumI]/minus[massI])/2
            velocityLinear=actual[momentumI]/masses-velocities*actual[massI]/masses
            admitted=loss<.01 and scaled<.1
            probes.append(dict(factor=factor,componentMaterializationLoss=loss,maximumIndependentGateFraction=scaled,
              physicalResidualDefect=(defect*rowUnits).tolist(),scaledDefect=(defect/gates).tolist(),
              actualIncrement=actual.tolist(),observedResponse=(observed*rowUnits).tolist(),expectedResponse=(expected*rowUnits).tolist(),
              velocityChange_m_s=velocityChange.tolist(),velocityLinearizationDefect_m_s=(velocityChange-velocityLinear).tolist(),admitted=bool(admitted)))
            if not admitted:failures.append(dict(case=name,direction=kind,factor=factor,materializationLoss=loss,gateFraction=scaled))
        directions.append(dict(kind=kind,probes=probes))
    rows.append(dict(case=name,initialMass_kg=masses.tolist(),oldVelocityAtol_m_s=(1e-8/masses).tolist(),
      selectedMomentumAtol_kg_m_s=atol[momentumI].tolist(),initialVelocity_m_s=velocities.tolist(),directions=directions))
old=json.load(open(sys.argv[1]));cold,_,_=fixture(15.2e6,0.,True,False);candidate=velocity_atol(cold[:nativeSize])
delta=np.array(old['correction']);pred=np.array(old['predictorOffset']);oldWeighted=delta/(originalAtol+1e-4*abs(pred));newWeighted=delta/(candidate+1e-4*abs(pred))
print(json.dumps(dict(scope='One M0 times 1e-10 m/s momentum absolute budget; unchanged physical residual/Jacobian and all other solver settings',
 results=rows,failures=failures,overlapAccepted=not failures,oldNewtonPredictorWeights=dict(oldWRMS=float(np.sqrt(np.mean(oldWeighted**2))),
 newWRMS=float(np.sqrt(np.mean(newWeighted**2))),oldMaximum=float(max(abs(oldWeighted))),newMaximum=float(max(abs(newWeighted)))),
 independentPhysicalScreensUnchanged=True,trajectoryQualified=False,wall_s=time.perf_counter()-started),allow_nan=False))
`

if (import.meta.main) {
  const [receipt, newton, python, output] = Bun.argv.slice(2)
  if (!receipt || !newton || !python || !output || Bun.argv.length !== 6) throw Error('Usage: velocity-budget.ts delivery.json retained-newton.json research-python output.json')
  const old = await Bun.file(receipt).json(), previous = await Bun.file(newton).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input) || previous.inputHash !== hash(input)) throw Error('Retained parent input mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(velocityOverlapCalculation), inputHash: hash(input), newtonHash: hash(await Bun.file(newton).text()) }
  const child = Bun.spawn([python, '-c', velocityOverlapCalculation, newton], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code) throw Error('Static budget admission did not complete')
  await Bun.write(output, JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
  console.log({ output })
}

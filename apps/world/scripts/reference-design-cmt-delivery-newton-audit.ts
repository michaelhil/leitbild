/** One retained-state BE-equivalent Newton correction, not another integration. */
import { createHash } from 'node:crypto'
import { deliveryIdaSetup } from './reference-design-cmt-delivery-ida.ts'

export const newtonAuditSetup = deliveryIdaSetup + String.raw`
retained=json.load(open(sys.argv[1]))['records'][-1]['returnedStates']
row=next(r for r in retained if abs(r['returnedInternalTime_s']-.0007)<1e-15)
if not row['admitted'] or any(len(row[k])!=totalSize or not np.all(np.isfinite(row[k])) for k in ['solverOffset','returnedDerivative']):
    raise ValueError('Retained state is unadmitted, nonfinite or dimensionally incompatible')
x0=initial(15.2e6);Y0,cv,pv,r,receiver,pb,pt,tb=port_views(x0)
va=boundary_initial(pt,tb,0.,'valve',True);ca=boundary_initial(receiver,pb,1.,'check',True)
base=np.r_[Y0,x0[pressureIndex],va,ca,0.,0.];mode=(0.,True,False,True)
old=np.array(row['solverOffset']);oldyp=np.array(row['returnedDerivative']);h=.0002;cj=1/h
predictor=old+h*oldyp;yp=(predictor-old)/h
F=ida_residual(base+predictor,yp,*mode)
J=ida_jacobian(base+predictor,cj,lambda inc:ida_residual(base+predictor+inc,yp,*mode))
delta=np.linalg.solve(J,-F);corrected=predictor+delta
after=ida_residual(base+corrected,(corrected-old)/h,*mode)
weights=np.array(row['statistics']['errorWeights'])
blocks={'fieldM':np.r_[0:nc,3*nc:3*nc+np_],'fieldP':np.r_[nc:2*nc,3*nc+np_:3*nc+2*np_],
 'fieldE':energyIndex,'dviNative':np.arange(nativeSize-2,nativeSize),'fieldPressure':np.arange(nativeSize,nativeSize+N),
 'dviPressureEntropy':np.arange(nativeSize+N,nativeSize+pressureCount),'junctions':np.arange(totalSize-10,totalSize-2),'quadratures':np.arange(totalSize-2,totalSize)}
summary={k:dict(maxResidualBefore=float(max(abs(F[ii]))),maxResidualAfter=float(max(abs(after[ii]))),
 maximumWeightedCorrection=float(max(abs(delta[ii]*weights[ii]))),
 maximumMaterializationLoss=float(max(abs(((base+corrected)-(base+predictor)-delta)[ii])))) for k,ii in blocks.items()}
# Challenge actual pressure/density flash outputs at the three largest storage residuals.
worst=np.argsort(abs(after[nativeSize:nativeSize+N]))[-3:][::-1];thermo=[]
for globalCell in worst:
    o=cm if globalCell<nc else pm;i=int(globalCell if globalCell<nc else globalCell-nc)
    off=0 if globalCell<nc else 3*nc;n=o['n'];samples=[]
    for label,all_ in [('predictor',base+predictor),('corrected',base+corrected)]:
        trial=make_trial(all_[:nativeSize],all_[nativeSize:nativeSize+pressureCount]);M,P,pc=trial[off:off+3*n].reshape(3,n)
        mean=M/o['V'];cells,S,_=prepared(dict(cells=[c['c'] for c in o['cells']],faces=[dict(left=j,right=j+1) for j in range(n-1)]));slope=S@mean;c=cells[i]
        probes=[]
        for z,w in zip(c['nodes'],c['weights']):
            dz=z-c['z'];rho=mean[i]+slope[i]*dz;p=pc[i]-g*(mean[i]*dz+slope[i]*dz*dz/2)
            u,T,du=density_props(rho,p);returnedP=water.p();returnedRho=water.rhomass()
            water.update(CoolProp.DmassT_INPUTS,float(rho),float(T));forwardP=water.p();forwardU=water.umass()
            probes.append(dict(z_m=float(z),weight_m3=float(w),rho=float(rho),requestedPressure_Pa=float(p),
              returnedPressureDefect_Pa=float(returnedP-p),returnedDensityDefect_kg_m3=float(returnedRho-rho),
              forwardPressureDefect_Pa=float(forwardP-p),forwardEnergyDifference_J_kg=float(forwardU-u),T_K=float(T),du_dp=du))
        native,_,ep=forward(o,M,P,pc)
        samples.append(dict(state=label,pressure_Pa=float(pc[i]),nativeE_J=float(native[2*n+i]),derivative_J_Pa=float(ep[i]),probes=probes))
    pred=base+predictor;trial=make_trial(pred[:nativeSize],pred[nativeSize:nativeSize+pressureCount]);M,P,pc=trial[off:off+3*n].reshape(3,n)
    altered=pc.copy();altered[i]+=samples[1]['pressure_Pa']-samples[0]['pressure_Pa']
    fixedM=forward(o,M,P,altered)[0][2*n+i]-samples[0]['nativeE_J']
    thermo.append(dict(cell=int(globalCell),samples=samples,
      energyDifference_J=samples[1]['nativeE_J']-samples[0]['nativeE_J'],
      fixedMassMomentumPressureEnergyDifference_J=float(fixedM),
      pressureOnlyLinearEnergy_J=samples[0]['derivative_J_Pa']*(samples[1]['pressure_Pa']-samples[0]['pressure_Pa']),
      pressureTargetEnergyBiasEstimate_J=[sum(q['weight_m3']*q['rho']*q['du_dp']*q['forwardPressureDefect_Pa'] for q in s['probes']) for s in samples]))
`
export const newtonAuditCalculation = newtonAuditSetup + String.raw`print(json.dumps(dict(scope='One BE-equivalent predictor/correction at retained accepted .0007s, not IDA internal iterate or a trajectory',
 h_s=h,cj_per_s=cj,weightConvention='IDA weights at the prior accepted state, not a trial LTE test',blocks=summary,residualBefore=F.tolist(),residualAfter=after.tolist(),
 linearSolveDefect=(J@delta+F).tolist(),correction=delta.tolist(),
 actualMaterializedCorrection=((base+corrected)-(base+predictor)).tolist(),
 predictorOffset=predictor.tolist(),correctedOffset=corrected.tolist(),thermodynamicProbes=thermo,
 noPhysicalOrSolverChange=True),allow_nan=False))
`
if (import.meta.main) {
  const [inputReceipt, stepsReceipt, python, output] = Bun.argv.slice(2)
  if (!inputReceipt || !stepsReceipt || !python || !output || Bun.argv.length !== 6) throw Error('Usage: newton-audit.ts delivery.json steps.json python output.json')
  const old = await Bun.file(inputReceipt).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  if ((await Bun.file(stepsReceipt).json()).inputHash !== hash(input)) throw Error('Accepted-step parent input identity mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(newtonAuditCalculation), inputHash: hash(input), stepsHash: hash(await Bun.file(stepsReceipt).text()) }
  const child = Bun.spawn([python, '-c', newtonAuditCalculation, stepsReceipt], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code) throw Error('Static Newton audit failed')
  await Bun.write(output, JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
  console.log({ output })
}

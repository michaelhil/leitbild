/** Static gate for the same native DAE with downstream PT coordinates. No time integration. */
import { createHash } from 'node:crypto'
import { deliveryIdaSetup } from './reference-design-cmt-delivery-ida.ts'

export const deliveryConditioningCalculation = deliveryIdaSetup + String.raw`
# The historical HP diagnosis is retained separately, with its exact emitted Python.
x=initial(15.21e6);x[nc:2*nc]=.01*x[:nc];x[3*nc+np_:3*nc+2*np_]=.01*x[3*nc:3*nc+np_]
_,_,_,_,left,right,_,_=port_views(x);hot={}
try:boundary_initial(left,right,1.,'failed-open',False,hot)
except ValueError as error:hot['rejection']=str(error)
j,pL,pR,Td=hot['candidate'];samples=[];q0=boundary_pt(pR,Td)
for dt in [-1e-6,-5e-7,0.,5e-7,1e-6]:
    q=boundary_pt(pR,Td+dt)
    samples.append(dict(temperatureOffset_K=dt,enthalpy_J_kg=q['h'],enthalpyLinearizationDefect_J_kg=q['h']-q0['h']-q0['cp']*dt,
      cp_J_kgK=q['cp'],temperatureAtolEquivalentEnthalpy_J_kg=q['cp']*1e-9))
hot['forwardPTSamples']=samples

def owned_state(moving):
    x=initial(15.2e6);x[nc:2*nc]=moving*x[:nc];x[3*nc+np_:3*nc+2*np_]=moving*x[3*nc:3*nc+np_]
    Y,cv,pv,r,receiver,pb,pt,tb=port_views(x);closed=moving==0.;alpha=0. if closed else .25
    drive=receiver['p']-pb['p']+pb['rho']*pb['c']*pb['v'];seated=drive>=-b['checkCrack_Pa']
    va=boundary_initial(pt,tb,alpha,'valve',closed);ca=boundary_initial(receiver,pb,1.,'check',seated)
    full=np.r_[Y,x[pressureIndex],va,ca,0.,0.];_,d,_,v=ida_evaluate(full,alpha,seated,False,closed)
    yp=np.r_[d,np.zeros(pressureCount+8),v['kineticChainRate_W'],v['wallDissipation_W']]
    return full,yp,(alpha,seated,False,closed),x,r

def finite_reservoir_derivative(r):
    # From h(p(z),s)+gz=h(pref,s)+gzref, integrated on this SAME physical envelope.
    pr,s=r['p_reference'],r['s'];q0=r['at'](b['dviPort_m']);rho0=q0['rho'];T0=q0['T'];H0=q0['h']+g*b['dviPort_m']
    nodes,weights=leggauss(8);z=(b['dviBottom_m']+b['dviTop_m'])/2+nodes*(b['dviTop_m']-b['dviBottom_m'])/2
    weights=weights*b['dviVolume_m3']/2;mp=ms=mt=0.
    for zz,w in zip(z,weights):
        q=r['at'](zz);_valve_water.update(CP.PT_INPUTS,q['p'],q['T'])
        rp=_valve_water.first_partial_deriv(CP.iDmass,CP.iP,CP.iSmass)
        rs=_valve_water.first_partial_deriv(CP.iDmass,CP.iSmass,CP.iP)
        mp+=w*rp*q['rho']/rho0;ms+=w*(rs+rp*q['rho']*(T0-q['T']));mt+=w*q['rho']*q['T']
    exact=np.array([[mp,ms],[H0*mp,H0*ms+mt]])
    tests=[]
    for factor in [1.,.5]:
        columns=[]
        for i,h in enumerate([100.*factor,.001*factor]):
            plus=[pr,s];minus=plus.copy();plus[i]+=h;minus[i]-=h;a=res['forward'](*plus);c=res['forward'](*minus)
            columns.append([(a['M']-c['M'])/(2*h),(a['E']-c['E'])/(2*h)])
        fd=np.array(columns).T;tests.append(dict(factor=factor,finiteDifference=fd.tolist(),componentRelativeError=(abs(fd-exact)/abs(exact)).tolist()))
    return dict(analytic=exact.tolist(),finiteDifferences=tests)

massIndices=np.r_[np.arange(nc),np.arange(3*nc,3*nc+np_),nativeSize-2].astype(int)
momentumIndices=np.r_[np.arange(nc,2*nc),np.arange(3*nc+np_,3*nc+2*np_)].astype(int)
energyIndices=np.r_[energyIndex,nativeSize-1].astype(int)
blocks=dict(mass=massIndices,momentum=momentumIndices,energy=energyIndices,
  pressure=np.arange(nativeSize,nativeSize+pressureCount),junction=np.arange(totalSize-10,totalSize-2),diagnostic=np.arange(totalSize-2,totalSize))
atol=np.r_[np.full(nc,1e-9),np.full(nc,1e-8),np.full(nc,1e-3),np.full(np_,1e-9),np.full(np_,1e-8),np.full(np_,1e-3),1e-9,1e-3,
  np.full(N+1,.1),1e-8,np.tile([1e-8,.1,.1,1e-9],2),1e-8,1e-8]
rowGate=np.r_[np.full(nc,1e-5),np.full(nc,.001),np.full(nc,1e-4),np.full(np_,1e-5),np.full(np_,.001),np.full(np_,1e-4),1e-5,1e-4,
  np.full(N,1e-6),1e-7,1e-6,np.tile([1e-6,1e-6,1e-6,1e-5],2),1e-6,1e-6]
dy=np.zeros(totalSize);dy[:nativeSize]=1/nativeScales;dy[-2:]=1.
results=[]
for name,moving in [('closed-rest',0.),('moving-forward',-.01)]:
    start=time.perf_counter();full,yp,mode,x,r=owned_state(moving);fun=lambda delta:ida_residual(full+delta,yp,*mode)
    f0=fun(np.zeros(totalSize));probe=ida_physical_probes();matrices=[];rowg=rowGate.copy()
    if mode[3]:rowg[-10]=1e-8
    if mode[1]:rowg[-6]=1e-8
    for factor in [1.,.5]:
        columns=[]
        for j,h in enumerate(probe*factor):
            d=np.zeros(totalSize);d[j]=h;columns.append((fun(d)-fun(-d))/(2*h))
        matrices.append(np.column_stack(columns))
    A0,A1=matrices
    selected=ida_jacobian(full,0.,fun)
    selectedDifference={key:float(max(abs(((selected-A1)/rowg[:,None])[:,ids]*atol[ids]).ravel())) for key,ids in blocks.items()}
    # Exact native-E identity entries and all of their other rows are known without EOS probing.
    exactEnergy=np.zeros((totalSize,len(energyIndices)))
    for k in range(N):exactEnergy[nativeSize+k,k]=1e-4
    exactEnergy[nativeSize+N+1,-1]=1e-4
    eerrors=[float(max(abs(a[:,energyIndices]-exactEnergy).ravel())/1e-4) for a in matrices]
    zeroRows=exactEnergy==0;ezero=[float(max(abs(a[:,energyIndices][zeroRows]))) for a in matrices]
    fieldEP=np.r_[forward(cm,*x[:3*nc].reshape(3,nc))[2],forward(pm,*x[3*nc:3*N].reshape(3,np_))[2]]
    epError=[float(max(abs(np.diag(a[nativeSize:nativeSize+N,nativeSize:nativeSize+N])+fieldEP/1e4)/(fieldEP/1e4))) for a in matrices]
    # True native-E and diagnostic zero dependencies; no sparsity inferred from small numbers.
    diagZero=[float(max(abs(a[:,-2:]).ravel())) for a in matrices]
    columnDiff={key:float(max(abs((A0-A1)[:,ids]*probe[ids]).ravel())) for key,ids in blocks.items()}
    scaledColumnDiff={key:float(max(abs(((A0-A1)/rowg[:,None])[:,ids]*atol[ids]).ravel())) for key,ids in blocks.items()}
    algebraic=np.arange(nativeSize,totalSize-2);Ga=A0[np.ix_(algebraic,algebraic)]
    gaScaled=Ga*atol[algebraic][None,:]/rowg[algebraic][:,None];sv=np.linalg.svd(gaScaled,compute_uv=False)
    tangent=np.linalg.solve(Ga,-A0[np.ix_(algebraic,np.r_[np.arange(nativeSize),totalSize-2,totalSize-1])]
      @yp[np.r_[np.arange(nativeSize),totalSize-2,totalSize-1]])
    tangentResidual=float(max(abs(Ga@tangent+A0[algebraic]@yp)))
    directions=[]
    for key in ['mass','pressure','junction']:
        d=np.zeros(totalSize);ids=blocks[key];d[ids]=probe[ids]*np.sin(np.arange(len(ids))+.7)
        actual=(fun(d)-fun(-d))/2;prediction=A0@d
        directions.append(dict(block=key,maximumRawDefect=float(max(abs(actual-prediction))),
          blockRawDefects={rkey:float(max(abs((actual-prediction)[rids]))) for rkey,rids in blocks.items()},
          maximumScaledDefect=float(max(abs(actual-prediction)/rowg))))
    matricesSummary=[]
    for cj in [100.,1e4,1e6]:
        J=A0+np.diag(cj*dy);scaled=J*atol[None,:]/rowg[:,None];u,svals,vh=np.linalg.svd(scaled)
        weak=atol*vh[-1];a=(fun(weak)-fun(-weak))/2+cj*dy*weak;pred=J@weak
        materialized=((full+weak)-(full-weak))/2
        matricesSummary.append(dict(cj_per_s=cj,scaledCondition=float(svals[0]/svals[-1]),
          scaledSmallestSingular=float(svals[-1]),weakDirectionPredictedScaled=float(np.linalg.norm(pred/rowg)),
          weakDirectionActualScaled=float(np.linalg.norm(a/rowg)),weakDirectionDifferenceScaled=float(np.linalg.norm((a-pred)/rowg)),
          weakPerturbationLostCoordinates=int(np.count_nonzero((weak!=0)&(materialized==0))),
          weakMaterializationErrorInAtol=float(np.linalg.norm((materialized-weak)/atol))))
    results.append(dict(case=name,initialMaximumScaledResidual=float(max(abs(f0)/rowg)),
      nativeEnergyIdentityRelativeErrors=eerrors,nativeEnergyForbiddenCoupling=ezero,diagnosticForbiddenCoupling=diagZero,
      fieldEnergyPressureDerivativeRelativeErrors=epError,baseHalfMaximumColumnProbeDefect=columnDiff,
      selectedVersusUnmaskedHalfProbeAtPhysicalTolerance=selectedDifference,
      baseHalfErrorAtPhysicalAbsoluteTolerance=scaledColumnDiff,algebraicScaledSingularValues=sv.tolist(),
      algebraicScaledCondition=float(sv[0]/sv[-1]),fixedModeFixedOpeningAlgebraicTangent=tangent.tolist(),tangentLinearResidual=tangentResidual,
      finiteReservoirDerivative=finite_reservoir_derivative(r),directions=directions,fullMatrices=matricesSummary,wall_s=time.perf_counter()-start))
print(json.dumps(dict(hotInitialization=hot,states=results,diagnosticOnly=True,timedPilotRun=False,
  derivativeInterfaceAccepted=False,versions=dict(CoolProp=CoolProp.__version__,sksundae=sksundae.__version__)),allow_nan=False))
`

if (import.meta.main) {
  const [receipt, python, output] = Bun.argv.slice(2)
  if (!receipt || !python || !output || Bun.argv.length !== 5) throw Error('Usage: cmt-delivery-conditioning.ts delivery.json research-python output.json')
  const old = await Bun.file(receipt).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(deliveryConditioningCalculation), inputHash: hash(input) }
  const child = Bun.spawn([python, '-c', deliveryConditioningCalculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw Error('Static CMT conditioning diagnosis did not complete')
  await Bun.write(output, JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
  console.log(output)
}

/** Offline, explicitly capped CMT bottom-path experiment. Not a full plant operating alignment. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'
import { columnMesh } from './reference-design-cmt-well-balanced.ts'
import { pressureCoordinatesSetup } from './reference-design-cmt-pressure-coordinates.ts'
import { hydrostaticLiquidPython } from './reference-design-hydrostatic-liquid.ts'

const positive = z.number().finite().positive()
const schema = z.object({ length_m: positive, bore_m: positive, roughness_m: positive, valveZoneLength_m: positive,
  dviBottom_m: z.number(), dviTop_m: z.number(), dviPort_m: z.number(), dviVolume_m3: positive,
  referenceFlow_kg_s: positive, totalLoss_Pa: positive, checkCrack_Pa: positive, opening_s: positive, closing_s: positive }).strict()
export function deliveryBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-delivery\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-cmt-delivery block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (b.valveZoneLength_m >= b.length_m || !(b.dviBottom_m < b.dviPort_m && b.dviPort_m < b.dviTop_m)) throw Error('Invalid finite outlet geometry')
  return b
}
export const deliveryCalculation = pressureCoordinatesSetup + hydrostaticLiquidPython + String.raw`
from scipy.optimize import root
b=data['delivery'];A=math.pi*b['bore_m']**2/4
cm=compile_column(data['meshes'][0]);pm=compile_column(data['pipeMesh']);nc=cm['n'];np_=pm['n'];N=nc+np_
res=make_liquid_reservoir(b['dviVolume_m3']/(b['dviTop_m']-b['dviBottom_m']),b['dviBottom_m'],b['dviTop_m'],b['dviPort_m'])
ref=liquid_pt_si(15.2e6,313.15);water.update(CoolProp.PT_INPUTS,15.2e6,313.15);mu=water.viscosity()
Re=b['referenceFlow_kg_s']*b['bore_m']/(A*mu)
fref=brentq(lambda f:1/math.sqrt(f)+2*math.log10(b['roughness_m']/(3.7*b['bore_m'])+2.51/(Re*math.sqrt(f))),.001,.2)
pipeDrop=fref*b['length_m']/b['bore_m']*b['referenceFlow_kg_s']**2/(2*ref['rho']*A*A)
mixingDrop=b['referenceFlow_kg_s']**2/(2*ref['rho']*A*A)
valveDrop=b['totalLoss_Pa']-pipeDrop-mixingDrop
if valveDrop<=0:raise ValueError('Selected pipe exceeds total reference loss budget')
Kvalve=valveDrop/b['referenceFlow_kg_s']**2
check('one reference wall valve and discharge budget Pa',pipeDrop+valveDrop+mixingDrop-b['totalLoss_Pa'],1e-9)

def field_initial(o,tapPressure):
    M=ref['rho']*o['V'];P=np.zeros(o['n'])
    centers=np.array([c['z'] for c in o['cells']]);pc=tapPressure-ref['rho']*g*(centers-b['dviPort_m'])
    return np.r_[M,P,pc]

def decode(x):
    c=x[:3*nc];p=x[3*nc:3*N]
    cy,cv,_=forward(cm,*c.reshape(3,nc));py,pv,_=forward(pm,*p.reshape(3,np_))
    reservoir=res['forward'](x[-2],x[-1])
    return np.r_[cy,py,reservoir['M'],reservoir['E']],cv,pv,reservoir

def rates(x,alpha,seated,failedOpen):
    Y,cv,pv,r=decode(x);co=dict(cm,recover=lambda unused:cv);po=dict(pm,recover=lambda unused:pv)
    cd,cdet=operator(co,Y[:3*nc]);pd,pdet=operator(po,Y[3*nc:3*N]);cd=cd.reshape(3,nc);pd=pd.reshape(3,np_)
    if alpha>0:
        flux=hllc(pv[1][-1,1],cv[1][0,0]);flux[2]+=g*data['mouth_m']*flux[0];flux*=A
        cd[:,0]+=flux-cdet['flux'][0];pd[:,-1]-=flux-pdet['flux'][-1]
    else:flux=np.zeros(3)
    port=r['at'](b['dviPort_m']);water.update(CoolProp.PT_INPUTS,port['p'],port['T']);q=np.array([port['rho'],0.,port['p'],port['u'],water.speed_sound()])
    if seated:
        receive=np.zeros(3)
    else:
        receive=hllc(q,pv[1][0,0]);receive[2]+=g*b['dviPort_m']*receive[0];receive*=A
        pd[:,0]+=receive-pdet['flux'][0]
    M,P,E=Y[3*nc:3*N].reshape(3,np_);v=P/M;rho=M/pm['V'];wallDrag=np.zeros(np_);valveDrag=np.zeros(np_);checkDrag=np.zeros(np_)
    for i in range(np_):
        if v[i]==0:continue
        density_props(rho[i],pv[0][i]);viscosity=water.viscosity();re=rho[i]*abs(v[i])*b['bore_m']/viscosity
        laminar=64/re
        if re<=2300:f=laminar
        else:
            turbulent=brentq(lambda f:1/math.sqrt(f)+2*math.log10(b['roughness_m']/(3.7*b['bore_m'])+2.51/(re*math.sqrt(f))),.001,.2)
            f=turbulent if re>=4000 else laminar+(turbulent-laminar)*(re-2300)/1700
        wallDrag[i]-=A*f*data['pipeLengths_m'][i]/b['bore_m']*rho[i]*v[i]*abs(v[i])/2
    if alpha>0:valveDrag[-1]-=A*Kvalve*ref['rho']/rho[-1]*(rho[-1]*A*v[-1])*abs(rho[-1]*A*v[-1])/(alpha*alpha)
    # Forward check flow is negative in the upward pipe coordinate. Open cracking force opposes it.
    if not seated and not failedOpen:checkDrag[0]+=A*b['checkCrack_Pa']
    drag=wallDrag+valveDrag+checkDrag
    pd[1]+=drag
    # No total-energy drag source: lost resolved K remains within native E, hence becomes U.
    d=np.r_[cd.ravel(),pd.ravel(),-receive[0],-receive[2]]
    return Y,d,dict(sourceFlow_kg_s=-float(flux[0]),receiverFlow_kg_s=-float(receive[0]),
      dviPressure_Pa=r['p_reference'],pipeCheckHead_Pa=float((pdet['flux'][0,1]/A if seated else pv[1][0,0,2])-port['p']),
      kineticEnergy_J=float(sum(Y[nc:2*nc]**2/(2*Y[:nc]))+sum(P*P/(2*M))),
      dragPower_W=float(-drag@v),wallDissipation_W=float(-wallDrag@v),valveDissipation_W=float(-valveDrag@v),
      checkDissipation_W=float(-checkDrag@v),receiverEnergyFlow_W=-float(receive[2]),
      inclinedGravityForceResidual_N=float(max(abs(A*(pv[1][:,1,2]-pv[1][:,0,2])+g*M*(data['mouth_m']-b['dviPort_m'])/b['length_m']))),
      maximumVelocity_m_s=float(max(max(abs(Y[nc:2*nc]/Y[:nc])),max(abs(v)))))

def step(old,dt,alpha,seated,failedOpen):
    oldY=decode(old)[0];scales=np.r_[np.full(nc,1.),np.full(nc,1.),np.full(nc,1e4),np.full(np_,1.),np.full(np_,1.),np.full(np_,1e4),1e4,.01]
    row=np.r_[np.full(nc,1e-7),np.full(nc,1e-5),np.full(nc,.01),np.full(np_,1e-7),np.full(np_,1e-5),np.full(np_,.01),1e-7,.01]
    calls=0
    def residual(delta):
        nonlocal calls
        calls+=1;Y,d,view=rates(old+scales*delta,alpha,seated,failedOpen)
        return (Y-oldY-dt*d)/row
    def jac(delta):
        # Resolvable physical probes; no zero-increment machine-epsilon differentiation.
        h=np.r_[np.full(nc,1e-7),np.full(nc,1e-6),np.full(nc,.01),np.full(np_,1e-7),np.full(np_,1e-6),np.full(np_,.01),.01,.1]
        return np.column_stack([(residual(delta+np.eye(len(old))[j]*hh)-residual(delta-np.eye(len(old))[j]*hh))/(2*hh) for j,hh in enumerate(h)])
    begun=time.perf_counter();sol=root(residual,np.zeros(len(old)),jac=jac,options=dict(xtol=1e-8,maxfev=1000))
    defect=residual(sol.x);x=old+scales*sol.x;Y,d,view=rates(x,alpha,seated,failedOpen)
    if not sol.success or max(abs(defect))>1:raise ValueError(dict(reason='Connected native residual rejected',message=str(sol.message),maximumScaledResidual=float(max(abs(defect))),calls=calls))
    if failedOpen:consistent=True
    elif seated:consistent=view['pipeCheckHead_Pa']<=b['checkCrack_Pa']+.001
    else:consistent=view['receiverFlow_kg_s']>=0 and view['checkDissipation_W']>=0
    check('accepted inclined pipe gravity force N',view['inclinedGravityForceResidual_N'],1e-5)
    if min(view['wallDissipation_W'],view['valveDissipation_W'])<0:raise ValueError('Wall or valve assists actual velocity')
    numericalK=0.
    for offset,n in [(0,nc),(3*nc,np_)]:
        M,P,E=Y[offset:offset+3*n].reshape(3,n);Mo,Po,Eo=oldY[offset:offset+3*n].reshape(3,n);v=P/M
        numericalK+=float(sum(-v*v/2*(M-Mo)+v*(P-Po)-(P*P/(2*M)-Po*Po/(2*Mo))))
    return x,dict(**view,scaledResidual=float(max(abs(defect))),calls=calls,wall_s=time.perf_counter()-begun,
      backwardEulerKineticDefect_J=numericalK,seated=seated,checkConsistent=consistent,dt_s=dt,alpha=alpha)

def initial(receiverPressure,heat=0):
    seed=liquid_pt_si(receiverPressure,563.15);r=res['forward'](seed['p'],seed['s'])
    if heat:r=res['recover'](r['M'],r['E']+heat,(seed['p'],seed['s']))
    return np.r_[field_initial(cm,15.2e6),field_initial(pm,receiverPressure),r['p_reference'],r['s']]

def native_ledger(Y,old):
    delta=Y-old
    mass=sum(delta[:nc])+sum(delta[3*nc:3*nc+np_])+delta[-2]
    energy=sum(delta[2*nc:3*nc])+sum(delta[3*nc+2*np_:3*N])+delta[-1]
    check('closed apparatus total mass kg',mass,1e-6);check('closed apparatus total energy J',energy,.1)
    return float(mass),float(energy)

def run(name,dt,duration,receiverPressure,closed=False,failedOpen=False,heat=0):
    x=initial(receiverPressure,heat);oldY=decode(x)[0];history=[];seated=(not failedOpen) and (closed or receiverPressure>=15.2e6)
    physicalLoss=numericalK=0.;maxMass=maxEnergy=0.;failure=None;start=time.perf_counter()
    for k in range(round(duration/dt)):
        t=(k+1)*dt;alpha=0. if closed else min(t/b['opening_s'],1.)
        try:
            candidate,row=step(x,dt,alpha,seated,failedOpen)
            if not row['checkConsistent']:
                # A different physical active set, not clipping flow or retrying a failed nonlinear solve.
                candidate,row=step(x,dt,alpha,not seated,False)
            if not row['checkConsistent']:raise ValueError('Neither healthy check active set is admissible')
            Y=decode(candidate)[0];mass,energy=native_ledger(Y,oldY)
            seated=row['seated'];x=candidate
            maxMass=max(maxMass,abs(mass));maxEnergy=max(maxEnergy,abs(energy))
            physicalLoss+=dt*row['dragPower_W'];numericalK+=row['backwardEulerKineticDefect_J']
            history.append(dict(t_s=t,**row,receiverMassChange_kg=float(Y[-2]-oldY[-2]),receiverEnergyChange_J=float(Y[-1]-oldY[-1])))
        except (ValueError,RuntimeError) as error:
            failure=dict(t_s=t,reason=str(error));break
    return dict(case=name,dt_s=dt,requestedDuration_s=duration,completed= failure is None,failure=failure,history=history,
      maximumMassLedger_kg=maxMass,maximumEnergyLedger_J=maxEnergy,physicalDragEnergy_J=physicalLoss,
      backwardEulerKineticDefect_J=numericalK,backwardEulerOverPhysicalDrag=None if physicalLoss==0 else numericalK/physicalLoss,
      wall_s=time.perf_counter()-start,initialNativeState=oldY.tolist(),finalNativeState=decode(x)[0].tolist())

runs=[]
for args in [('opening',.05,.5,15.19e6),('opening-refined',.025,.5,15.19e6),
  ('closed-rest',.05,.05,15.2e6,True),('closed-receiver-heat',.05,.05,15.2e6,True,False,1000),
  ('reverse-failed-open',.05,.05,15.21e6,False,True),('reverse-healthy-check',.05,.05,15.21e6)]:
    row=run(*args);runs.append(row)
    print(json.dumps(dict(completedCase=row['case'],completed=row['completed'],failure=row['failure'],wall_s=row['wall_s'])),file=sys.stderr,flush=True)
comparison=None
differences=[(a,b_) for a in runs[0]['history'] for b_ in runs[1]['history'] if abs(a['t_s']-b_['t_s'])<1e-10]
if differences:
    dp=max(abs(a['dviPressure_Pa']-b_['dviPressure_Pa']) for a,b_ in differences)
    dm=max(abs(a['receiverMassChange_kg']-b_['receiverMassChange_kg']) for a,b_ in differences)
    modes=all(a['seated']==b_['seated'] for a,b_ in differences)
    comparison=dict(commonSamples=len(differences),lastCommonTime_s=max(a['t_s'] for a,b_ in differences),
      fullDurationCompleted=bool(runs[0]['completed'] and runs[1]['completed']),maximumDviPressureDifference_Pa=float(dp),maximumReceiverMassDifference_kg=float(dm),
      checkModesAgree=bool(modes),pressureScreen_Pa=100.,massScreen_kg=.0001,commonPrefixScreenPassed=bool(dp<100 and dm<.0001 and modes))
print(json.dumps(dict(input=data,runs=runs,temporalComparison=comparison,pipeFrictionFactorReference=fref,pipeReferenceLoss_Pa=pipeDrop,
    valveReferenceLoss_Pa=valveDrop,dischargeMixingAllocation_Pa=mixingDrop,checks=checks,
    connectedCandidateCompleted=all(r['completed'] for r in runs),transientAccuracyQualified=False,
    meridionalReceiptQualified=False,pressureIntegrityQualified=False,liveRuntime=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, injection, python] = Bun.argv.slice(2)
  if (!owner || !injection || !python || Bun.argv.length !== 5) throw Error('Usage: cmt-delivery.ts geometry.md injection.md python')
  const doc = await Bun.file(owner).text(), geometry = parseGeometryBasis(doc), delivery = deliveryBasis(await Bun.file(injection).text())
  const mouth = tankGeometry(geometry).mouth, A = Math.PI * delivery.bore_m ** 2 / 4, rise = mouth - delivery.dviPort_m
  if (rise <= 0 || rise >= delivery.length_m) throw Error('Selected outlet route cannot reach its endpoints')
  const lengthCuts = [0, (delivery.length_m - delivery.valveZoneLength_m) / 3, 2 * (delivery.length_m - delivery.valveZoneLength_m) / 3, delivery.length_m - delivery.valveZoneLength_m, delivery.length_m]
  const heights = lengthCuts.map(s => delivery.dviPort_m + rise * s / delivery.length_m)
  const pipeMesh = { cells: heights.slice(1).map((hi, i) => ({ volume_m3: A * (lengthCuts[i + 1]! - lengthCuts[i]!), pieces: [{ lo: heights[i]!, hi, coefficients: [A * delivery.length_m / rise, 0, 0] }] })),
    faces: heights.slice(1, -1).map((z, i) => ({ left: i, right: i + 1, area_m2: A, sampleHeights_m: [z] })), elevations_m: heights, faceAreas_m2: heights.map(() => A) }
  const input = { basis: parseAcousticBasis(doc), geometry, mouth_m: mouth, delivery, centerPressureInterval_Pa: [10e6, 20e6], meshes: [columnMesh(geometry)], pipeMesh, pipeLengths_m: lengthCuts.slice(1).map((s, i) => s - lengthCuts[i]!) }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(deliveryCalculation), inputHash: hash(JSON.stringify(input)) }
  const child = Bun.spawn([python, '-c', deliveryCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('Connected CMT delivery discriminator rejected')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
}

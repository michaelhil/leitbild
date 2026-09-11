/** Offline change-of-coordinates discriminator on the retained CMT physical operator. No transient solver. */
import { createHash } from 'node:crypto'
import { parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'
import { columnMesh, wellBalancedSetup } from './reference-design-cmt-well-balanced.ts'

export const pressureCoordinatesCalculation = wellBalancedSetup + String.raw`
def forward(o,M,P,pc):
    # Independent forward implementation: only current native M/P, trial pressure, and geometry.
    n=o['n']
    if any(len(a)!=n for a in [M,P,pc]) or not np.all(np.isfinite(np.r_[M,P,pc])) or min(M)<=0:
        raise ValueError('Invalid pressure-coordinate state')
    if min(pc)<PLO or max(pc)>PHI:raise ValueError('Pressure coordinate outside declared liquid bracket')
    cells,S,_=prepared(dict(cells=[c['c'] for c in o['cells']],faces=[dict(left=i,right=i+1) for i in range(n-1)]))
    mean=M/o['V'];slope=S@mean;U=[];PE=[];derivative=[];traces=[]
    for i,c in enumerate(cells):
        energy=potential=dEdp=0.
        def state(z):
            x=z-c['z'];r=mean[i]+slope[i]*x;p=pc[i]-g*(mean[i]*x+slope[i]*x*x/2)
            u,T,du=density_props(r,p)
            return r,p,u,du,water.speed_sound()
        for z,w in zip(c['nodes'],c['weights']):
            r,p,u,du,sound=state(z);energy+=w*r*u;potential+=w*r*g*z;dEdp+=w*r*du
        U.append(energy);PE.append(potential);derivative.append(dEdp)
        traces.append([[r,P[i]/M[i],p,u,sound] for z in [o['z'][i],o['z'][i+1]] for r,p,u,du,sound in [state(z)]])
    U=np.array(U);PE=np.array(PE);E=U+P*P/(2*M)+PE
    return np.r_[M,P,E],(pc.copy(),np.array(traces),U,PE),np.array(derivative)

rows=[]
for mesh in data['meshes']:
    o=compile_column(mesh);n=o['n'];initial=o['initialize']('nonpolynomial');p0cells,tr,U,PE=o['recover'](initial)
    heat=initial.copy();heat[2*n:]+=10000*(band_weights(o,7,8)-band_weights(o,9,10))
    cases=[('heterogeneous-rest',initial),('paired-heat',heat)]
    face=int(np.flatnonzero(o['z']==8.)[0])
    for sign in [1,-1]:
        y=initial.copy();donor,receiver=(face-1,face) if sign>0 else (face,face-1)
        r,v,p,u,c=tr[donor,1 if sign>0 else 0];dm=.005;de=dm*(u+p/r+g*o['z'][face])
        y[donor]-=dm;y[receiver]+=dm;y[2*n+donor]-=de;y[2*n+receiver]+=de
        cases.append(('material-'+str(sign),y))
    # Finite moving native state challenges the kinetic part of the coordinate map as well.
    moving=heat.copy();velocity=.01*np.sin(np.arange(n)+.5);moving[n:2*n]=moving[:n]*velocity
    moving[2*n:]+=moving[:n]*velocity*velocity/2;cases.append(('heat-and-momentum',moving))
    for name,y in cases:
        M,P,E=y.reshape(3,n);pc,oldtr,oldU,oldPE=o['recover'](y)
        rebuilt,view,ep=forward(o,M,P,pc)
        energyError=float(max(abs(rebuilt[2*n:]-E)));peError=float(max(abs(view[3]-oldPE)))
        check('forward native E roundtrip J',energyError,.001);check('independent current PE quadrature J',peError,1e-6)
        if min(ep)<=0:raise ValueError('Nonpositive admitted pressure-energy derivative')
        differences=[]
        for step in [100.,50.]:
            plus=forward(o,M,P,pc+step)[0][2*n:];minus=forward(o,M,P,pc-step)[0][2*n:]
            differences.append(float(max(abs((plus-minus)/(2*step)-ep)/ep)))
        check('HEOS pressure-energy derivative full step relative',differences[0],1e-5)
        check('HEOS pressure-energy derivative half step relative',differences[1],1e-5)
        # The same RHS gets DIRECT traces, not another native inverse hidden in its pressure path.
        direct=dict(o,recover=lambda unused:view);fd,dd=operator(direct,rebuilt);fi,di=operator(o,y)
        rhsErrors=np.max(abs((fd-fi).reshape(3,n)),axis=1)
        for label,value,tol in zip(['mass kg/s','momentum N','total energy W'],rhsErrors,[1e-7,1e-4,.1]):
            check('same physical RHS '+label,float(value),tol)
        check('closed direct mass-rate ledger kg/s',sum(fd[:n]),1e-7)
        check('closed direct total-energy-rate ledger W',sum(fd[2*n:]),.01)
        # A finite known energy addition tests physical pressure feedback, not just a derivative identity.
        target=int(np.argmax(ep));heated=y.copy();heated[2*n+target]+=1000
        ph=o['recover'](heated)[0];actual=float(ph[target]-pc[target]);linear=1000/ep[target]
        if actual<=0:raise ValueError('Finite heat pressure response lost')
        check('finite heat pressure versus local EOS tangent relative',abs(actual-linear)/linear,.01)
        others=np.delete(ph-pc,target);check('unheated pressure remains local at fixed native mass Pa',max(abs(others)),1e-5)
        rows.append(dict(cells=n,case=name,maximumNativeEnergyRoundtrip_J=energyError,maximumPotentialEnergyDifference_J=peError,
            derivativeRange_J_Pa=[float(min(ep)),float(max(ep))],derivativeRelativeErrors=differences,
            maximumRhsDifference_by_M_P_E=rhsErrors.tolist(),finiteHeat_J=1000.,heatedCell=target,
            finiteHeatPressure_Pa=actual,tangentHeatPressure_Pa=float(linear),
            maximumPressureDifferenceFromRest_Pa=float(max(abs(pc-p0cells))),
            maximumVelocity_m_s=float(max(abs(P/M))),directFaceFlux=dd['flux'].tolist()))
    for bad in [np.full(n,9e6),np.full(n,float('nan'))]:
        rejected=False
        try:forward(o,initial[:n],initial[n:2*n],bad)
        except ValueError:rejected=True
        if not rejected:raise ValueError('Unsupported pressure trial accepted')
        check('unsupported pressure trial rejected',0,0)
print(json.dumps(dict(scope='Forward pressure-coordinate equivalence and local HEOS energy feedback; no nonlinear advancement or installed BAL/DVI join',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),results=rows,checks=checks,
    coordinateChecksPassed=True,nonlinearSolverQualified=False,speedupMeasured=False,receivingPathQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-pressure-coordinates.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, mouth_m: tankGeometry(geometry).mouth, centerPressureInterval_Pa: [10e6, 20e6], meshes: [columnMesh(geometry), columnMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(pressureCoordinatesCalculation), inputHash: hash(JSON.stringify(input)) }
  const child = Bun.spawn([python, '-c', pressureCoordinatesCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT pressure-coordinate discriminator failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(out) }, null, 2))
}

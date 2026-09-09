/** Actual-domain small-disturbance pressure/momentum architecture discriminator; not nonlinear CMT flow. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, ringArea, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const positive = z.number().finite().positive()
const schema = z.object({ pressure_MPa: positive, temperature_C: z.number().finite(), pulse_Pa: positive,
  duration_s: positive, steps_s: z.tuple([positive, positive]), referenceFlow_kg_s: positive,
  impedanceReferenceTemperature_C: z.number().finite(), holeDischargeCoefficient: positive.max(1),
  balanceLoss_Pa: positive, outletLoss_Pa: positive, dviVolume_m3: positive,
  maximumMidpointRelativeError: positive, maximumTagDifference_kg: positive }).strict()
export function parseAcousticBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-acoustics\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-acoustics block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (b.steps_s[1] !== b.steps_s[0] / 2 || b.steps_s.some(dt => Math.abs(b.duration_s / dt - Math.round(b.duration_s / dt)) > 1e-8))
    throw new Error('Reference steps must halve and divide duration')
  return b
}

export function acousticMesh(b: GeometryBasis, fine = false) {
  const g = tankGeometry(b), unique = (x: number[]) => [...new Set(x)].sort((a, b) => a - b)
  const refine = (x: number[]) => unique([...x, ...x.slice(1).map((v, i) => (v + x[i]!) / 2)])
  let rr = [0, b.bodyOuterDiameter_m / 2, g.R / 2, g.R]
  let zz = unique([g.mouth, b.bottomProbe_m, b.bottomDatum_m + 1, b.bottomDatum_m + 2,
    b.bottomDatum_m + 3, b.bottomDatum_m + 4, b.topProbe_m, b.bodyBottom_m, b.bodyTop_m,
    ...b.ringElevations_m.flatMap(z => [z - b.holeDiameter_m / 2, z, z + b.holeDiameter_m / 2]),
    g.roof(b.feedOuterDiameter_m / 2)])
  if (fine) { rr = refine(rr); zz = refine(zz) }
  const cells: { volume_m3: number; rIndex: number; zIndex: number }[] = []
  const ids = new Map<string, number>()
  for (let j = 1; j < zz.length; j++) for (let i = 1; i < rr.length; i++) {
    const v = g.volume(zz[j - 1]!, zz[j]!, rr[i - 1]!, rr[i]!)
    if (v > 1e-14) { ids.set(`${i}:${j}`, cells.length); cells.push({ volume_m3: v, rIndex: i, zIndex: j }) }
  }
  const faces: { left: number; right: number; area_m2: number; direction: 0 | 1; dualVolume_m3: number }[] = []
  const holes: { cell: number; area_m2: number }[] = [], mouth: { cell: number; area_m2: number }[] = []
  cells.forEach((c, id) => {
    const i = c.rIndex, j = c.zIndex
    for (const [key, area, direction] of [
      [`${i + 1}:${j}`, g.radialFace(rr[i]!, zz[j - 1]!, zz[j]!), 0],
      [`${i}:${j + 1}`, g.area(zz[j]!, rr[i - 1]!, rr[i]!), 1],
    ] as const) {
      const neighbor = ids.get(key)
      if (neighbor !== undefined && area > 0) faces.push({ left: id, right: neighbor, area_m2: area,
        direction, dualVolume_m3: (c.volume_m3 + cells[neighbor]!.volume_m3) / 2 })
    }
    if (rr[i - 1] === b.bodyOuterDiameter_m / 2) {
      const area = b.ringElevations_m.reduce((a, z) => a + ringArea(b, z, zz[j - 1]!, zz[j]!), 0)
      if (area > 0) holes.push({ cell: id, area_m2: area })
    }
    if (j === 1) { const area = g.area(g.mouth, rr[i - 1]!, rr[i]!); if (area > 0) mouth.push({ cell: id, area_m2: area }) }
  })
  const volume = cells.reduce((s, c) => s + c.volume_m3, 0)
  if (Math.abs(volume - b.freeWater_m3) > 1e-10 || !holes.length || !mouth.length) throw new Error('Incomplete acoustic geometry')
  const movingByDirection = [0, 1].map(d => faces.filter(f => f.direction === d).reduce((s, f) => s + f.dualVolume_m3, 0))
  if (movingByDirection.some(v => v > b.freeWater_m3 + 1e-10)) throw new Error('Component metric adds fluid mass')
  return { cells, faces, holes, mouth, movingComponentVolume_m3: movingByDirection,
    unallocatedBoundaryHalfVolume_m3: movingByDirection.map(v => b.freeWater_m3 - v),
    internalBAL_m3: g.inventories.internalBAL_m3, externalBAL_m3: g.inventories.externalBAL_m3,
    freeWater_m3: volume }
}

export const acousticCalculation = String.raw`
import json,sys,math
import numpy as np
import scipy
from scipy.linalg import expm,lu_factor,lu_solve,null_space
from CoolProp.CoolProp import PropsSI
import CoolProp
data=json.load(sys.stdin);b=data['basis'];geo=data['geometry'];g=9.80665
p0=b['pressure_MPa']*1e6;T0=b['temperature_C']+273.15
def water(T):
    return dict(rho=PropsSI('D','P',p0,'T',T,'Water'),sound=PropsSI('A','P',p0,'T',T,'Water'),
      mu=PropsSI('V','P',p0,'T',T,'Water'),conductivity=PropsSI('L','P',p0,'T',T,'Water'),
      cp=PropsSI('C','P',p0,'T',T,'Water'))
w=water(T0);hot=water(b['impedanceReferenceTemperature_C']+273.15);rho=w['rho'];sound=w['sound'];checks=[]
def check(name,value,tolerance):
    v=float(value)
    if not math.isfinite(v) or abs(v)>tolerance:raise ValueError(name+': '+str(v))
    checks.append(dict(name=name,residual=v,tolerance=tolerance))

def operators(mesh):
    n=len(mesh['cells']);nf=len(mesh['faces']);V=np.array([c['volume_m3'] for c in mesh['cells']]+
      [mesh['externalBAL_m3'],mesh['internalBAL_m3'],b['dviVolume_m3']]);N=len(V)
    ext,plenum,dvi=n,n+1,n+2;C=V/(rho*sound**2);I=np.array([rho*f['dualVolume_m3']/f['area_m2']**2 for f in mesh['faces']])
    B=np.zeros((N,nf));G=np.zeros((2*n,n));componentV=np.zeros((n,2))
    for k,f in enumerate(mesh['faces']):
        a,c=f['left'],f['right'];A=f['area_m2'];d=f['direction'];B[a,k]=1;B[c,k]=-1
        # Actual central collocated gradient comparator; not assumed a priori to have an extra exact nullspace.
        for node in [a,c]:G[2*node+d,a]-=A/2;G[2*node+d,c]+=A/2
        componentV[a,d]+=mesh['cells'][a]['volume_m3']/2;componentV[c,d]+=mesh['cells'][c]['volume_m3']/2
    check('per-component existing-mass upper bound',max(0,float(np.max(componentV-V[:n,None]))),1e-12)
    # Reference-slope TEST impedances. No assertion that zero-flow physical orifice has this derivative.
    ref=b['referenceFlow_kg_s'];areaH=sum(f['area_m2'] for f in mesh['holes']);areaO=sum(f['area_m2'] for f in mesh['mouth'])
    apertureLoss=(ref/(b['holeDischargeCoefficient']*areaH))**2/(2*hot['rho']);feedLoss=b['balanceLoss_Pa']-apertureLoss
    if feedLoss<=0:raise ValueError('No reference feed-loss budget')
    ports=[dict(left=ext,right=plenum,R=2*feedLoss*hot['rho']/ref,kind='feed')]
    ports += [dict(left=plenum,right=f['cell'],R=2*apertureLoss*hot['rho']/ref*areaH/f['area_m2'],kind='aperture') for f in mesh['holes']]
    ports += [dict(left=f['cell'],right=dvi,R=2*b['outletLoss_Pa']*rho/ref*areaO/f['area_m2'],kind='outlet') for f in mesh['mouth']]
    Bp=np.zeros((N,len(ports)));resistance=np.array([p['R'] for p in ports])
    for k,p in enumerate(ports):Bp[p['left'],k]=1;Bp[p['right'],k]=-1
    K=(B/np.sqrt(I)[None,:])/np.sqrt(C)[:,None]
    P=(Bp/np.sqrt(resistance)[None,:])/np.sqrt(C)[:,None];D=P@P.T
    A=np.block([[-D,-K],[K.T,np.zeros((nf,nf))]])
    check('scaled pressure-work and physical test-impedance identity',np.linalg.norm(A+A.T+2*np.block([[D,np.zeros((N,nf))],[np.zeros((nf,N+nf))]])),1e-6)
    check('one common-pressure graph nullspace',np.linalg.matrix_rank(np.c_[B,Bp])-(N-1),0)
    constant=np.r_[np.sqrt(C),np.zeros(nf)]
    check('common-pressure held state',np.linalg.norm(A@constant),1e-8)
    loop=null_space(B)
    if loop.shape[1]==0:raise ValueError('Expected an actual-domain circulation cycle')
    circulation=np.r_[np.zeros(N),np.sqrt(I)*loop[:,0]];circulation/=np.linalg.norm(circulation)
    check('unforced undamped divergence-free circulation',np.linalg.norm(A@circulation),1e-7)
    # Compare energy Rayleigh quotients for actual alternating r/z cell pressure, with a common offset removed.
    checker=np.array([(-1.)**(c['rIndex']+c['zIndex']) for c in mesh['cells']]);checker-=np.average(checker,weights=C[:n])
    stag=float(np.sum((B[:n].T@checker)**2/I));center=float(np.sum((G@checker)**2/np.repeat(rho*V[:n],2)))
    rankCentered=int(np.linalg.matrix_rank(G));rankStaggered=int(np.linalg.matrix_rank(B[:n]))
    Fs=np.zeros((nf+len(ports),N+nf));Fs[:nf,N:]=np.diag(1/np.sqrt(I));Fs[nf:,:N]=(Bp.T/np.sqrt(C)[None,:])/resistance[:,None]
    Btotal=np.c_[B,Bp]
    return dict(A=A,C=C,I=I,B=B,Bp=Bp,Btotal=Btotal,Fs=Fs,V=V,N=N,n=n,nf=nf,ext=ext,plenum=plenum,dvi=dvi,
      ports=ports,resistance=resistance,mesh=mesh,checkerboard=dict(staggeredForceEnergy=stag,centralForceEnergy=center,
      centralToStaggeredRatio=center/stag,centralGradientRank=rankCentered,staggeredGradientRank=rankStaggered,
      pressureCellCount=n),testImpedance=dict(feed_Pa_s_m3=ports[0]['R'],allAperturesParallel_Pa_s_m3=2*apertureLoss*hot['rho']/ref,
      allOutletsParallel_Pa_s_m3=2*b['outletLoss_Pa']*rho/ref))

def propagator(A,dt):
    n=len(A);aug=np.zeros((2*n,2*n));aug[:n,:n]=A;aug[:n,n:]=np.eye(n)
    E=expm(aug*dt);return E[:n,:n],E[:n,n:]

def initial(o,reverse=False):
    p=np.zeros(o['N']);p[o['ext']]=(-1 if reverse else 1)*b['pulse_Pa'];p-=np.average(p,weights=o['C'])
    return np.r_[np.sqrt(o['C'])*p,np.zeros(o['nf'])]

def run(o,dt,reverse=False):
    N=o['N'];A=o['A'];E,J=propagator(A,dt);x=initial(o,reverse);x0=x.copy();E0=float(x@x/2)
    M0=rho*o['V'];mass=lambda y:M0+rho*np.sqrt(o['C'])*y[:N]
    oldM=mass(x);initialM=oldM.copy();tag=np.zeros(N);tag[o['ext']]=1;initialTag=float(oldM@tag)
    original=tag.copy();transfer=np.zeros(len(o['ports']));absoluteTransfer=np.zeros(len(o['ports']))
    maxMass=maxTag=maxUniform=0.;maxVelocity=0.;reversalIntervals=0;history=[];oldFlows=o['Fs']@x
    midpoint=lu_solve(lu_factor(np.eye(len(A))-dt*A/2),np.eye(len(A))+dt*A/2);trial=x0.copy();historyError=0.
    for step in range(round(b['duration_s']/dt)):
        new=E@x;newM=mass(new);integrated=o['Fs']@(J@x);F=rho*integrated
        maxMass=max(maxMass,float(np.max(np.abs(newM-oldM+o['Btotal']@F))))
        newFlows=o['Fs']@new;reversalIntervals+=int(np.sum(oldFlows*newFlows<0))
        Q=np.diag(newM.copy())
        for k,m in enumerate(F):
            a=int(np.flatnonzero(o['Btotal'][:,k]>0)[0]);c=int(np.flatnonzero(o['Btotal'][:,k]<0)[0])
            donor,receiver=(a,c) if m>=0 else (c,a);amount=abs(m);Q[donor,donor]+=amount;Q[receiver,donor]-=amount
        tag=np.linalg.solve(Q/newM[:,None],oldM*tag/newM)
        check_uniform=float(np.max(np.abs(Q@np.ones(N)-oldM)))
        maxUniform=max(maxUniform,check_uniform)
        if not np.all(np.isfinite(tag)) or min(tag)<-1e-12 or max(tag)>1+1e-12 or min(newM)<=0:raise ValueError('Finite tracer donor/mass domain failed')
        maxTag=max(maxTag,abs(float(newM@tag)-initialTag));transfer+=F[o['nf']:];absoluteTransfer+=abs(F[o['nf']:])
        vel=(new[N:]/np.sqrt(o['I']))/np.array([f['area_m2'] for f in o['mesh']['faces']]);maxVelocity=max(maxVelocity,float(np.max(abs(vel))))
        trial=midpoint@trial;historyError=max(historyError,float(np.linalg.norm(trial-new)/math.sqrt(2*E0)))
        x=new;oldM=newM;oldFlows=newFlows
        if step in [0,round(b['duration_s']/dt)//2-1,round(b['duration_s']/dt)-1]:
            p=x[:N]/np.sqrt(o['C']);history.append(dict(t_s=(step+1)*dt,externalBALPressurePerturbation_Pa=float(p[o['ext']]),
              plenumPressurePerturbation_Pa=float(p[o['plenum']]),dviPressurePerturbation_Pa=float(p[o['dvi']]),
              acousticEnergy_J=float(x@x/2),tankOriginMass_kg=float(oldM[:o['n']]@tag[:o['n']]),dviOriginMass_kg=float(oldM[o['dvi']]*tag[o['dvi']])))
    exact=expm(A*b['duration_s'])@x0
    check('repeated exact propagation versus independent full-interval exponential',np.linalg.norm(x-exact)/math.sqrt(2*E0),2e-8)
    check('finite linearized per-cell material balance',maxMass,2e-9)
    check('finite donor tracer conservation',maxTag,2e-9)
    check('uniform material tag preserved under actual signed exchange',maxUniform,2e-9)
    check('closed total linearized material mass',sum(oldM-initialM),2e-8)
    check('no unforced acoustic energy growth',max(0,float(x@x/2-E0)),E0*1e-9+1e-18)
    error=float(np.linalg.norm(trial-exact)/math.sqrt(2*E0))
    return dict(dt_s=dt,reverse=reverse,initialEnergy_J=E0,finalEnergy_J=float(x@x/2),derivedImpedanceEnergyLoss_J=E0-float(x@x/2),
      maximumMaterialResidual_kg=maxMass,maximumTagResidual_kg=maxTag,maximumInternalVelocity_m_s=maxVelocity,
      maximumMach=maxVelocity/sound,faceSignChangingIntervals=reversalIntervals,
      totalPortMass_kg=transfer.tolist(),sumAbsoluteIntervalPortMass_kg=absoluteTransfer.tolist(),
      tracerInventory_kg=(oldM*tag).tolist(),history=history,midpointRelativeEnergyNormError=error,
      midpointMaximumSampledHistoryError=historyError,midpointScreenPassed=historyError<=b['maximumMidpointRelativeError'])

meshResults=[]
for mesh in data['meshes']:
    o=operators(mesh);cases=[run(o,dt) for dt in b['steps_s']];cases.append(run(o,b['steps_s'][1],True))
    tagDifference=max(abs(np.array(cases[0]['tracerInventory_kg'])-np.array(cases[1]['tracerInventory_kg'])))
    # A reported failing screen stays visible; conservation acceptance is independent.
    reverseMass=max(abs(np.array(cases[1]['totalPortMass_kg'])+np.array(cases[2]['totalPortMass_kg'])))
    check('signed linear source and receiver reversal',reverseMass,1e-10)
    held=np.r_[np.sqrt(o['C'])*b['pulse_Pa'],np.zeros(o['nf'])]
    check('actual common pressure propagated unchanged',np.linalg.norm(expm(o['A']*b['duration_s'])@held-held),1e-10)
    meshResults.append(dict(cells=o['n'],momentumFaces=o['nf'],finitePressureStores=o['N'],unknowns=len(o['A']),
      componentMovingVolume_m3=mesh['movingComponentVolume_m3'],unallocatedBoundaryHalfVolume_m3=mesh['unallocatedBoundaryHalfVolume_m3'],
      checkerboard=o['checkerboard'],testImpedance=o['testImpedance'],cases=cases,
      tagTemporalDifference_kg=float(tagDifference),tagScreenPassed=bool(tagDifference<=b['maximumTagDifference_kg'])))
hole=geo['holeDiameter_m'];ref=b['referenceFlow_kg_s'];areaH=geo['holesPerRing']*len(geo['ringElevations_m'])*math.pi*(hole/2)**2
regime=[]
for label,ww in [('cold',w),('hot',hot)]:
    velocity=ref/(ww['rho']*areaH);Re=ww['rho']*velocity*hole/ww['mu'];Pe=ww['rho']*ww['cp']*velocity*hole/ww['conductivity']
    regime.append(dict(reference=label,temperature_C=b['temperature_C'] if label=='cold' else b['impedanceReferenceTemperature_C'],**ww,
      meanDischargeVelocity_m_s=velocity,meanHoleReynolds=Re,meanHolePeclet=Pe))
print(json.dumps(dict(scope='Full-domain linear acoustic pressure/momentum architecture and finite passive-origin transport; not nonlinear CMT thermodynamics',
  versions=dict(numpy=np.__version__,scipy=scipy.__version__,CoolProp=CoolProp.__version__),water=w,
  actualHotColdDensityFraction=abs(hot['rho']/rho-1),regime=regime,meshes=meshResults,checks=checks,
  nonlinearThermalTransportImplemented=False,physicalPortInertiaQualified=False,checksPassed=True),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-acoustics.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, meshes: [acousticMesh(geometry), acousticMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()), calculationHash: hash(acousticCalculation) }
  const child = Bun.spawn([python, '-c', acousticCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT acoustic architecture reference failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}

/** Offline general-water hydrostatic initialization discriminator, not an advancing CMT solver. */
import { createHash } from 'node:crypto'
import { acousticCoordinates, acousticMesh, parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

export function hydrostaticMesh(b: GeometryBasis, fine = false) {
  const g = tankGeometry(b), { rr, zz } = acousticCoordinates(b, fine), mesh = acousticMesh(b, fine)
  const cells = mesh.cells.map(c => {
    const r0 = rr[c.rIndex - 1]!, r1 = rr[c.rIndex]!, z0 = zz[c.zIndex - 1]!, z1 = zz[c.zIndex]!
    const cuts = [...new Set([z0, z1, ...g.breaks([r0, r1, b.bodyOuterDiameter_m / 2, b.feedOuterDiameter_m / 2])])]
      .filter(z => z >= z0 && z <= z1).sort((a, b) => a - b)
    const pieces = cuts.slice(1).map((hi, i) => {
      const lo = cuts[i]!, mid = (hi + lo) / 2, h = (hi - lo) / 2
      const am = g.area(mid - h / 2, r0, r1), a0 = g.area(mid, r0, r1), ap = g.area(mid + h / 2, r0, r1)
      return { lo, hi, coefficients: [a0, ap - am, 2 * (ap + am - 2 * a0)] }
    }).filter(p => p.coefficients.some(x => x !== 0))
    return { ...c, pieces }
  })
  return { ...mesh, cells }
}

export const hydrostaticCalculation = String.raw`
import json,sys,math
import numpy as np
import scipy
from scipy.integrate import solve_ivp,quad
from numpy.polynomial.legendre import leggauss
import CoolProp
from CoolProp import AbstractState,PT_INPUTS,DmassUmass_INPUTS
data=json.load(sys.stdin);b=data['basis'];geo=data['geometry'];g=9.80665;p0=b['pressure_MPa']*1e6
zlo=data['mouth_m'];ztop=geo['top_m'];cold=b['temperature_C']+273.15;hot=b['impedanceReferenceTemperature_C']+273.15
water=AbstractState('HEOS','Water');checks=[]
def props(p,T):
    water.update(PT_INPUTS,float(p),float(T))
    if water.phase()!=CoolProp.iphase_liquid:raise ValueError('Hydrostatic reference requires single-phase liquid water')
    return water.rhomass(),water.umass()
def check(name,value,tolerance):
    v=float(value)
    if not math.isfinite(v) or abs(v)>tolerance:raise ValueError(name+': '+str(v))
    checks.append(dict(name=name,residual=v,tolerance=tolerance))
def shape(piece,z):
    mid=(piece['hi']+piece['lo'])/2;h=(piece['hi']-piece['lo'])/2;x=(z-mid)/h;a,c,d=piece['coefficients']
    return a+c*x+d*x*x,(c+2*d*x)/h
def integral(cell,fn,order):
    x,w=leggauss(order);result=0.
    for piece in cell['pieces']:
        mid=(piece['hi']+piece['lo'])/2;h=(piece['hi']-piece['lo'])/2
        result+=h*sum(ww*fn(mid+h*xx,*shape(piece,mid+h*xx)) for xx,ww in zip(x,w))
    return result
profiles=[]
for label,Tbottom,Ttop in [('cold',cold,cold),('hot-top',cold,hot),('hot-bottom',hot,cold)]:
    T=lambda z:Tbottom+(Ttop-Tbottom)*(z-zlo)/(ztop-zlo)
    def rhs(z,y):return [-g*props(y[0],T(z))[0]]
    sol=solve_ivp(rhs,(ztop,zlo),[p0],method='DOP853',rtol=1e-12,atol=1e-6,dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    p=lambda z:float(sol.sol(z)[0]);sample=np.linspace(zlo,ztop,61)
    # An independently integrated density/head identity challenges the ODE dense pressure reconstruction.
    headError=max(abs(p(z)-p0-g*quad(lambda h:props(p(h),T(h))[0],z,ztop,epsabs=1e-8,epsrel=1e-12)[0]) for z in sample)
    check(label+' pressure versus integrated variable-density head Pa',headError,1e-3)
    # Isothermal Gibbs potential is an independent thermodynamic equilibrium invariant.
    gibbsError=None
    if Tbottom==Ttop:
        from CoolProp.CoolProp import PropsSI
        ref=PropsSI('G','P',p0,'T',Ttop,'Water')+g*ztop
        gibbsError=max(abs(PropsSI('G','P',p(z),'T',T(z),'Water')+g*z-ref) for z in sample)
        check('cold isothermal Gibbs plus gravity J/kg',gibbsError,1e-5)
    for z in sample:
        rho,u=props(p(z),T(z));water.update(DmassUmass_INPUTS,rho,u)
        check(label+' EOS point roundtrip pressure Pa',water.p()-p(z),.01)
        check(label+' EOS point roundtrip temperature K',water.T()-T(z),1e-7)
    meshes=[]
    for mesh in data['meshes']:
        results=[];maxForce=maxAbsForce=maxProjection=0.;quadrature=np.zeros(3);badSideForce=0.
        for c in mesh['cells']:
            V=c['volume_m3'];zc=integral(c,lambda z,A,Ap:z*A,8)/V
            check('cut-cell polynomial reproduces original volume m3',integral(c,lambda z,A,Ap:A,8)-V,1e-10)
            def moments(order):
                return np.array([integral(c,lambda z,A,Ap:props(p(z),T(z))[0]*A,order),
                    integral(c,lambda z,A,Ap:np.prod(props(p(z),T(z)))*A,order),
                    integral(c,lambda z,A,Ap:props(p(z),T(z))[0]*g*z*A,order)])
            coarse=moments(8);M,U,PE=moments(16);quadrature=np.maximum(quadrature,abs(coarse-[M,U,PE]))
            def reaction(gauge):
                q=lambda z:p(z)-gauge;force=0.;flat=0.
                for piece in c['pieces']:
                    lo,hi=piece['lo'],piece['hi'];ends=q(lo)*shape(piece,lo)[0]-q(hi)*shape(piece,hi)[0]
                    wall=quad(lambda z:q(z)*shape(piece,z)[1],lo,hi,epsabs=1e-7,epsrel=1e-12)[0]
                    force+=ends+wall;flat+=ends
                return force,flat
            force,flat=reaction(p0);absolute,_=reaction(0)
            maxForce=max(maxForce,abs(force-g*M));maxAbsForce=max(maxAbsForce,abs(absolute-g*M));badSideForce=max(badSideForce,abs(flat-g*M))
            water.update(DmassUmass_INPUTS,M/V,U/M)
            projectedP=water.p();projectedPhase=int(water.phase());projectedT=water.T()
            projectionError=projectedP-p(zc);maxProjection=max(maxProjection,abs(projectionError))
            results.append(dict(volume_m3=V,centroid_m=zc,mass_kg=M,internalEnergy_J=U,potentialEnergy_J=PE,
                centroidPressure_Pa=p(zc),centroidTemperature_K=T(zc),homogeneousEOSPressureError_Pa=projectionError,
                homogeneousEOSPressure_Pa=projectedP,homogeneousEOSTemperature_K=projectedT,
                homogeneousEOSPhaseCode=projectedPhase,homogeneousEOSLiquid=projectedPhase==CoolProp.iphase_liquid))
        check(label+' integrated mass quadrature kg',quadrature[0],1e-6)
        check(label+' internal energy quadrature J',quadrature[1],.1)
        check(label+' gravitational energy quadrature J',quadrature[2],.1)
        check(label+' gauge pressure full boundary reaction versus weight N',maxForce,1e-3)
        check(label+' absolute pressure full boundary reaction versus weight N',maxAbsForce,1e-3)
        # Challenge a tempting, but unqualified extension of frozen acoustic dual-mass gravity.
        residuals=[]
        for face in mesh['faces']:
            a,c=results[face['left']],results[face['right']]
            rhoFace=(a['mass_kg']/a['volume_m3']+c['mass_kg']/c['volume_m3'])/2
            head=g*rhoFace*face['dualVolume_m3']/face['area_m2'] if face['direction']==1 else 0.
            residuals.append(abs(a['centroidPressure_Pa']-c['centroidPressure_Pa']-head))
        meshes.append(dict(cells=len(results),totalMass_kg=sum(c['mass_kg'] for c in results),
            totalInternalEnergy_J=sum(c['internalEnergy_J'] for c in results),totalPotentialEnergy_J=sum(c['potentialEnergy_J'] for c in results),
            maxQuadratureDifferences=quadrature.tolist(),maximumFullBoundaryForceDefect_N=maxForce,
            maximumAbsolutePressureForceDefect_N=maxAbsForce,maximumOmittedSlopedWallForceDefect_N=badSideForce,
            maximumNaiveDualGravityHeadResidual_Pa=max(residuals),maximumHomogeneousCellPressureError_Pa=maxProjection,
            homogeneousProjectionNonLiquidCells=sum(not c['homogeneousEOSLiquid'] for c in results),
            inventories=results))
    for key,tolerance in [('totalMass_kg',1e-6),('totalInternalEnergy_J',.1),('totalPotentialEnergy_J',.1)]:
        check(label+' mesh partition invariance '+key,meshes[0][key]-meshes[1][key],tolerance)
    profiles.append(dict(name=label,temperatureBottom_K=Tbottom,temperatureTop_K=Ttop,
        bottomPressure_Pa=p(zlo),maximumHeadIntegralDefect_Pa=headError,isothermalGibbsDefect_J_kg=gibbsError,meshes=meshes))
# Reject a point in the real two-phase interval instead of clipping temperature or forcing liquid.
from CoolProp import PQ_INPUTS
water.update(PQ_INPUTS,p0,.5)
try:props(p0,water.T())
except ValueError:checks.append(dict(name='saturation point not silently treated as liquid',rejected=True))
else:raise ValueError('Saturation boundary unexpectedly admitted')
print(json.dumps(dict(scope='General-water hydrostatic initialization and geometry/mean-state discriminator; no time advancement or open port model',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),profiles=profiles,checks=checks,
    initializationChecksPassed=True,nonlinearTransportQualified=False,discreteWellBalancedTimeSolverQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-hydrostatic.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, mouth_m: tankGeometry(geometry).mouth, meshes: [hydrostaticMesh(geometry), hydrostaticMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    acousticSourceHash: hash(await Bun.file(new URL('./reference-design-cmt-acoustics.ts', import.meta.url)).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()), calculationHash: hash(hydrostaticCalculation) }
  const child = Bun.spawn([python, '-c', hydrostaticCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT hydrostatic initialization reference failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}

/** Offline clean/mobile-interface comparison, not a channel runtime closure. */
import { createHash } from 'node:crypto'
import { parseCondensationMeanComparison } from './reference-design-condensation-mean.ts'

export const parseCondensationMobileComparison = parseCondensationMeanComparison

export const condensationMobileCalculation = String.raw`
import sys,json,math,platform
import iapws,scipy
from iapws import IAPWS97 as W
from scipy.integrate import quad
b=json.load(sys.stdin);checks=[]
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))

def mobile_case(p,sub,d,u):
    f=W(P=p,x=0);v=W(P=p,x=1);l=W(P=p,T=f.T-sub)
    latent=(v.h-f.h)*1000;alpha=l.k/(l.rho*l.cp*1000)
    Pe=u*d/alpha;Re=l.rho*u*d/l.mu;Pr=l.cp*1000*l.mu/l.k
    h0=2/math.sqrt(math.pi)*l.k*math.sqrt(u/(d*alpha))
    M0=v.rho*math.pi*d**3/6;E0=M0*latent
    # h(D)=h0*(D/D0)^(-1/2); constant properties/pressure/speed/bath.
    # dM/dt= -pi*D^2*h(D)*sub/latent, hence m=(1-t/te)^2.
    te=v.rho*latent*d/(3*h0*sub)
    def mass_rate(m):return math.pi*d*d*h0*sub/latent*math.sqrt(m)
    integrated=quad(lambda m:M0/mass_rate(m),0,1,epsabs=1e-12,epsrel=1e-11)[0]
    require('independent mass-coordinate endpoint integral',math.isclose(te,integrated,rel_tol=1e-11))
    integratedHeat=quad(lambda t:math.pi*d*d*h0*sub*(1-t/te),0,te,
        epsabs=1e-10,epsrel=1e-11)[0]
    require('complete latent integral with zero terminal heat rate',
        math.isclose(E0,integratedHeat,rel_tol=1e-12))
    require('positive finite source prediction',all(math.isfinite(x) and x>0
        for x in [Pe,Re,Pr,h0,M0,te]))
    # Same boundary conditions, no terminal cap or favorable-temperature envelope.
    # At D=0 the inverse heat flux has its finite limiting value zero.
    def rigid_inverse_flux(D):
        if D==0:return 0.
        h=l.k/D*(2+.6*math.sqrt(l.rho*u*D/l.mu)*Pr**(1/3))
        return v.rho*latent/(2*h*sub)
    rigidTime=quad(rigid_inverse_flux,0,d,epsabs=1e-12,epsrel=1e-10)[0]
    # Pe=100 is a disclosed asymptotic diagnostic, NOT a validated source cutoff.
    # No remaining mass is removed; exact endpoint is mathematical extrapolation.
    beta100=min(1,100/Pe);mass100=beta100**3
    return dict(diameter_mm=d*1000,relativeVelocity_m_s=u,Re0=Re,Pr=Pr,Pe0=Pe,
        Weber0=l.rho*u*u*d/f.sigma,Eotvos0=(l.rho-v.rho)*9.80665*d*d/f.sigma,
        initialRadialSpeedOverSlip=h0*sub/(v.rho*latent*u),
        radialConvectionScalingDiagnostic=h0*sub/(v.rho*latent*u)*math.sqrt(Pe)/3,
        initialHTC_W_m2K=h0,initialLatentEnergy_J=E0,
        mathematicalEndpoint_ms=te*1000,
        sameBoundaryRigidSphereEndpoint_ms=rigidTime*1000,
        rigidOverMobileEndpointRatio=rigidTime/te,
        timeToPe100_ms=te*(1-beta100**1.5)*1000,
        residualMassFractionAtPe100=mass100,residualLatentEnergyAtPe100_J=E0*mass100,
        remainingEndpointExtrapolation_ms=te*beta100**1.5*1000,
        massCoordinateIntegration_ms=integrated*1000,
        massFractionAtHalfLifetime=.25,diameterFractionAtHalfLifetime=.5**(2/3))

results=[]
for o in b['observations']:
    rows=[mobile_case(o['pressure_MPa'],o['subcooling_K'],dmm/1000,u)
        for dmm in o['diameter_mm'] for u in b['relativeVelocityRange_m_s']]
    predicted=[min(x['mathematicalEndpoint_ms'] for x in rows),
        max(x['mathematicalEndpoint_ms'] for x in rows)]
    observed=o['lifetime_ms'];overlap=max(predicted[0],observed[0])<=min(predicted[1],observed[1])
    results.append(dict(id=o['id'],rows=rows,endpointInterval_ms=predicted,
        measuredLifetimeInterval_ms=observed,intervalOverlap=bool(overlap),
        fastestPredictionOverObservedUpper=predicted[0]/observed[1],
        minimumMassFractionAtObservedUpper=max(0,1-observed[1]/predicted[0])**2,
        fastestTimeToPe100_ms=min(x['timeToPe100_ms'] for x in rows),
        measuredSlipIsCaseSpecific=False,measuredShapeIsSpherical=False))

# These artificial states test the analytic similarity, not empirical accuracy.
base=mobile_case(.1,5,.002,.2)
diameter=mobile_case(.1,5,.004,.2)
speed=mobile_case(.1,5,.002,.8)
require('diameter scaling D^(3/2)',math.isclose(
    diameter['mathematicalEndpoint_ms']/base['mathematicalEndpoint_ms'],2**1.5,rel_tol=1e-12))
require('prescribed-speed scaling u^(-1/2)',math.isclose(
    speed['mathematicalEndpoint_ms']/base['mathematicalEndpoint_ms'],.5,rel_tol=1e-12))
print(json.dumps(dict(scope='Akiyama1973 equation15 mobile-interface external water challenge',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),
    liquidPropertyConvention='actual bulk temperature; saturated vapor density and latent enthalpy',
    slipConvention='published aggregate 0.20–0.25 m/s; not simultaneous per-case trajectories',
    geometryConvention='equivalent sphere; source experiment has deformed bubbles',
    endpointConvention='analytic high-Pe extrapolation; not physical late-stage admission',
    observationsUsedForFitting=False,matchedInDomainValidation=False,
    finiteBathOrChannelQualified=False,results=results,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [page, python, ...extra] = process.argv.slice(2)
  if (!page || !python || extra.length)
    throw Error('Usage: reference-design-condensation-mobile.ts <owner-page> <isolated-python>')
  const input = parseCondensationMobileComparison(await Bun.file(page).text())
  const proc = Bun.spawn([python, '-c', condensationMobileCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(condensationMobileCalculation), ...JSON.parse(out) }, null, 2))
}

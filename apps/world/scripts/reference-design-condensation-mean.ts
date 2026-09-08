/** Offline source-faithful mean-duty comparison; not an instantaneous channel law. */
import { createHash } from 'node:crypto'
import { parseCondensationAdmission } from './reference-design-condensation-admission.ts'

export function parseCondensationMeanComparison(document: string) {
  const { observations, observedUpperVelocity_m_s } = parseCondensationAdmission(document)
  return {
    observations,
    // Kamei–Hirata 1987 reports 0.20–0.25 m/s, not an individual-case trajectory.
    relativeVelocityRange_m_s: [0.2, observedUpperVelocity_m_s],
  }
}

export const condensationMeanCalculation = String.raw`
import sys,json,math,platform
import iapws
from iapws import IAPWS97 as W
b=json.load(sys.stdin);checks=[]
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
def source_mean(Re,Pr,Ja):
    Nu=.185*Re**.7*Pr**.5
    return Nu,1/(3*Nu*Ja),1.784*Re**(-.7)*Pr**(-.5)/Ja

# Numerical identity, not an experimental observation. Independently use initial
# sphere V/A and the source's half-initial-area averaging convention (equation 23).
d=.004;rhoV=1.0;hfg=2e6;k=.6;rhoL=1000.;cp=4200.;sub=10.;u=.4;mu=.0005
Re=rhoL*u*d/mu;Pr=cp*mu/k;Ja=rhoL*cp*sub/(rhoV*hfg)
Nu,FoDuty,FoLife=source_mean(Re,Pr,Ja)
V=math.pi*d**3/6;A=math.pi*d*d;h=Nu*k/d;alpha=k/(rhoL*cp)
tDuty=rhoV*hfg*V/(.5*A*h*sub)
require('initial-volume/half-initial-area duty identity',
    math.isclose(tDuty,FoDuty*d*d/alpha,rel_tol=1e-13))
require('separate published lifetime prefactor retained',
    math.isclose(FoLife/FoDuty,1.784*3*.185,rel_tol=1e-13) and FoLife!=FoDuty)
for exponent in [.5,1.,2.]:
    require('diameter scaling at fixed properties and speed',
        math.isclose(source_mean(Re*exponent,Pr,Ja)[1]*exponent**2/FoDuty,
            exponent**1.3,rel_tol=1e-13))

results=[]
for o in b['observations']:
    p=o['pressure_MPa'];sub=o['subcooling_K']
    f=W(P=p,x=0);v=W(P=p,x=1);l=W(P=p,T=f.T-sub)
    hfg=(v.h-f.h)*1000;alpha=l.k/(l.rho*l.cp*1000)
    Pr=l.cp*1000*l.mu/l.k;Ja=l.rho*l.cp*1000*sub/(v.rho*hfg)
    rows=[]
    for dmm in o['diameter_mm']:
        d=dmm/1000
        for u in b['relativeVelocityRange_m_s']:
            Re=l.rho*u*d/l.mu;Nu,FoDuty,FoLife=source_mean(Re,Pr,Ja)
            V=math.pi*d**3/6;A=math.pi*d*d;h=Nu*l.k/d
            meanDuty=.5*A*h*sub;tDuty=v.rho*hfg*V/meanDuty
            require('positive finite mean prediction',all(math.isfinite(x) and x>0
                for x in [Re,Pr,Ja,Nu,meanDuty,tDuty,FoLife]))
            require('dimensional duty identity',math.isclose(tDuty,FoDuty*d*d/alpha,rel_tol=1e-13))
            rows.append(dict(diameter_mm=dmm,relativeVelocity_m_s=u,Re=Re,Pr=Pr,Ja=Ja,
                meanNu=Nu,meanHTC_W_m2K=h,sphereEquivalentHalfInitialArea_m2=.5*A,
                sphereEquivalentMeanDuty_W=meanDuty,
                initialLatentEnergy_J=v.rho*hfg*V,sphereEquivalentDutyLifetime_ms=tDuty*1000,
                publishedLifetime_ms=FoLife*d*d/alpha*1000,
                sourceMeanReUpTo10000=bool(Re<=10000),sourceMeanJaUpTo80=bool(Ja<=80),
                sourceLifetimeJaUpTo60=bool(Ja<=60),
                insideReportedAggregatePrSpan=bool(2<Pr<15),
                insideReportedTrajectoryInitialRadius=0<d/2<.003,
                independentlyQualified=False))
    results.append(dict(id=o['id'],rows=rows,
        sphereEquivalentDutyLifetimeInterval_ms=[min(x['sphereEquivalentDutyLifetime_ms'] for x in rows),max(x['sphereEquivalentDutyLifetime_ms'] for x in rows)],
        publishedLifetimeInterval_ms=[min(x['publishedLifetime_ms'] for x in rows),max(x['publishedLifetime_ms'] for x in rows)],
        measuredLifetimeInterval_ms=o['lifetime_ms'],
        interpretation='external transfer challenge; not matched in-domain validation'))
print(json.dumps(dict(scope='Chen–Mayinger 1992 detached mean-transfer/lifetime comparison',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__),
    liquidPropertyConvention='actual bulk temperature; explicitly selected for this comparison',
    geometryConvention='equivalent sphere for separate duty identity; not measured true interface area',
    sourceLifetimeOverDutyLifetime=1.784*3*.185,
    sourceCoefficientDifference_percent=(1-1.784*3*.185)*100,
    observationsUsedForFitting=False,sourceCalibrationIndependentlyValidated=False,
    instantaneousChannelLawProvided=False,nominalLDChannelQualified=False,
    results=results,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [page, python, ...extra] = process.argv.slice(2)
  if (!page || !python || extra.length)
    throw Error('Usage: reference-design-condensation-mean.ts <owner-page> <isolated-python>')
  const input = parseCondensationMeanComparison(await Bun.file(page).text())
  const proc = Bun.spawn([python, '-c', condensationMeanCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(condensationMeanCalculation), ...JSON.parse(out) }, null, 2))
}

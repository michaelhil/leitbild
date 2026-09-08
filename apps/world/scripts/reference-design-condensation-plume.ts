/** Prescribed-flow ensemble reference; not a bubble lifetime or live channel model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const interval = z.tuple([positive, positive]).refine(([a, b]) => a < b)
const schema = z.object({
  design: z.literal('LD-01-condensation-plume'),
  imageScale_mm_px: positive,
  cases: z.array(z.object({
    id: z.enum(['SCUBA-18', 'SCUBA-72']),
    sourceNozzle: z.string().min(1),
    liquidTemperature_C: positive, subcooling_K: positive,
    effectiveDiameter_mm: positive, steamVelocity_m_s: positive,
    waterSuperficialVelocity_m_s: positive,
    nuCoefficient: positive, nuExponent: positive,
    peakPixel: interval,
    readings: z.array(z.object({ pixel: interval, normalizedOccupancy: interval }).strict()).min(1),
  }).strict()).length(2),
}).strict().superRefine((input, context) => {
  if (new Set(input.cases.map(c => c.id)).size !== input.cases.length)
    context.addIssue({ code: 'custom', message: 'Duplicate source case' })
  for (const c of input.cases) {
    if (c.steamVelocity_m_s <= c.waterSuperficialVelocity_m_s ||
      c.readings.some(r => r.pixel[1] >= c.peakPixel[0] || r.normalizedOccupancy[1] >= 1))
      context.addIssue({ code: 'custom', message: 'Require positive prescribed slip and downstream normalized readings' })
  }
})

export function parseCondensationPlume(document: string) {
  const blocks = [...document.matchAll(/^```reference-condensation-plume\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-condensation-plume block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const condensationPlumeCalculation = String.raw`
import sys,json,math,platform
import iapws,scipy
from iapws import IAPWS97 as W
from scipy.integrate import solve_ivp,quad
b=json.load(sys.stdin);checks=[]
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
results=[]
for c in b['cases']:
    T=c['liquidTemperature_C']+273.15;sub=c['subcooling_K']
    f=W(T=T+sub,x=0);v=W(T=T+sub,x=1);l=W(P=f.P,T=T)
    D=c['effectiveDiameter_mm']/1000;u=c['steamVelocity_m_s']
    slip=u-c['waterSuperficialVelocity_m_s'];latent=(v.h-f.h)*1000
    Re=l.rho*slip*D/l.mu;Pr=l.cp*1000*l.mu/l.k
    Ja=l.rho*l.cp*1000*sub/(v.rho*latent)
    Nu=c['nuCoefficient']*Re**c['nuExponent'];h=l.k*Nu/D
    # Effective area density ai=6*alpha/D. Constant vapor density and velocity.
    # F=rhoV*u*alpha; dF/dz=-ai*h*sub/hfg=-attenuation*F.
    attenuation=6*h*sub/(D*v.rho*latent*u)
    rigidNu=2+.6*math.sqrt(Re)*Pr**(1/3)
    rigidAttenuation=6*l.k*rigidNu*sub/(D*D*v.rho*latent*u)
    require('positive finite source package',all(math.isfinite(x) and x>0 for x in
        [Re,Pr,Ja,Nu,h,attenuation,rigidAttenuation]))
    # Finite alpha here is a numerical phase-source identity fixture, not measured void.
    volumeHeat=6*.01*h*sub/D;condensation=volumeHeat/latent
    liquidEnthalpy=condensation*f.h*1000+volumeHeat
    vaporEnthalpy=-condensation*v.h*1000
    require('phase enthalpy exchange cancels',
        abs(liquidEnthalpy+vaporEnthalpy)<1e-12*abs(vaporEnthalpy),id=c['id'])
    # An independent three-state conservation integration over three e-fold lengths.
    # Unit inlet mass flux is normalization, not an experimental inlet amplitude.
    length=3/attenuation
    def rhs(z,y):
        rate=attenuation*y[0]
        return [-rate,rate,latent*rate]
    solutions=[]
    for tolerance in [1e-7,1e-10]:
        sol=solve_ivp(rhs,[0,length],[1,0,0],rtol=tolerance,atol=tolerance*1e-3,
            t_eval=[length])
        require('independent mass/latent system converged',sol.success,id=c['id'])
        vapor,condensate,duty=map(float,sol.y[:,-1]);solutions.append(vapor)
        require('phase mass conserved',abs(vapor+condensate-1)<1e-12,id=c['id'])
        require('latent duty conserved without whole-fluid heat creation',
            abs(duty/latent-condensate)<1e-12,id=c['id'])
    require('refined integration matches analytic flux',abs(solutions[1]-math.exp(-3))<1e-10,id=c['id'])
    require('integration refinement converges',abs(solutions[0]-solutions[1])<1e-7,id=c['id'])
    integrated=quad(lambda z:attenuation*math.exp(-attenuation*z),0,length)[0]
    require('independent integrated source equals depleted flux',
        abs(integrated-(1-math.exp(-3)))<1e-12,id=c['id'])
    require('zero subcooling produces zero condensation',6*h*0/(D*v.rho*latent*u)==0)
    readings=[]
    for r in c['readings']:
        distance=[(c['peakPixel'][0]-r['pixel'][1])*b['imageScale_mm_px']/1000,
            (c['peakPixel'][1]-r['pixel'][0])*b['imageScale_mm_px']/1000]
        predicted=[math.exp(-attenuation*distance[1]),math.exp(-attenuation*distance[0])]
        observed=r['normalizedOccupancy']
        overlap=max(predicted[0],observed[0])<=min(predicted[1],observed[1])
        readings.append(dict(distance_m=distance,observedNormalizedOccupancy=observed,
            predictedNormalizedSteamFlux=predicted,conditionalReadingOverlap=bool(overlap),
            centerResidual=math.exp(-attenuation*sum(distance)/2)-sum(observed)/2))
    results.append(dict(id=c['id'],sourceNozzle=c['sourceNozzle'],pressure_MPa=f.P,
        effectiveDiameter_mm=c['effectiveDiameter_mm'],relativeSpeed_m_s=slip,
        Re=Re,Pr=Pr,Ja=Ja,Nu=Nu,HTC_W_m2K=h,attenuation_per_m=attenuation,
        halfFluxDistance_mm=math.log(2)/attenuation*1000,
        sameBoundaryRigidHalfFluxDistance_mm=math.log(2)/rigidAttenuation*1000,
        modelIntervalDiameterSource='fixed effective ensemble diameter; not individual-bubble shrinkage',
        insideReportedReSpan=bool(3000<=Re<=270000),insideReportedPrSpan=bool(1.75<=Pr<=1.9),
        insideReportedJaSpan=bool(16<=Ja<=35),
        readings=readings,refinedMassFluxAtThreeEFolds=solutions[1]))
print(json.dumps(dict(scope='SCUBA prescribed-motion effective-diameter detached-steam plume',
    sourceAssessmentCasesAreCalibrationDependent=True,independentEmpiricalHoldout=False,
    observableIsConditionalProjectedOccupancyProxy=True,liveChannelQualified=False,
    packages=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),
    results=results,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [page, python, ...extra] = process.argv.slice(2)
  if (!page || !python || extra.length)
    throw Error('Usage: reference-design-condensation-plume.ts <owner-page> <isolated-python>')
  const input = parseCondensationPlume(await Bun.file(page).text())
  const proc = Bun.spawn([python, '-c', condensationPlumeCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(condensationPlumeCalculation), ...JSON.parse(out) }, null, 2))
}

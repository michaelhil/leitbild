/** Offline original detached-event law; not a changing-channel runtime closure. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const interval = z.tuple([positive, positive]).refine(([a, b]) => a < b)
const schema = z.object({
  design: z.literal('LD-01-condensation-temporal'),
  observations: z.array(z.object({
    id: z.string().min(1),
    fluid: z.literal('R113'),
    pressure_bar: positive,
    subcooling_K: positive,
    Re0: positive,
    Pr: positive,
    Ja: positive,
    readings: z.array(z.object({
      FoTimes10000: interval,
      beta: interval.refine(([a, b]) => a > 0 && b < 1),
    }).strict()).min(1),
  }).strict()).length(2),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.observations.map(o => o.id)).size !== b.observations.length ||
      b.observations.some(o => o.readings.some((r, i) =>
        i > 0 && r.FoTimes10000[0] <= o.readings[i - 1]!.FoTimes10000[1])))
    ctx.addIssue({ code: 'custom', message: 'Require unique cases and ordered disjoint reading times' })
})

export function parseCondensationTemporal(document: string) {
  const blocks = [...document.matchAll(/^```reference-condensation-temporal\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-condensation-temporal block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const condensationTemporalCalculation = String.raw`
import sys,json,math,platform
import scipy
from scipy.integrate import quad
from scipy.optimize import brentq
b=json.load(sys.stdin);checks=[]
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))

# z=t/tEnd. Integrate dt/dm from the mass ODE, including its integrable
# zero-mass endpoint. This does not evaluate the analytic diameter solution.
def remaining_time(m,tolerance):
    if m==0:return 0.
    return quad(lambda x:1/2.7,0,m,weight='alg',wvar=(-17/27,0),
        epsabs=tolerance,epsrel=tolerance)[0]
def integrated_mass(z,tolerance):
    if z==0:return 1.
    if z==1:return 0.
    return brentq(lambda m:remaining_time(1.,tolerance)-remaining_time(m,tolerance)-z,
        0.,1.,xtol=1e-25,rtol=1e-14)

rows=[]
for z in [0.,.1,.25,.5,.75,.9,.99,.999,1.]:
    coarse=integrated_mass(z,1e-8);fine=integrated_mass(z,1e-11)
    beta=(1-z)**.9
    # Independent area/HTC-derived normalized heat: A~beta²,
    # h~beta^(-1/9); their product tends to zero, not infinity.
    heat=0. if fine==0 else 2.7*fine**(17/27)
    directDerivative=2.7*(1-z)**1.7
    require('independent mass-coordinate trajectory and refinement',
        abs(fine**(1/3)-beta)<1e-9 and abs(coarse-fine)<1e-10,
        z=z,massFraction=fine,beta=beta)
    require('instantaneous heat equals direct latent-mass derivative',
        abs(heat-directDerivative)<1e-10,z=z)
    rows.append(dict(z=z,massFraction=fine,beta=beta,normalizedHeatRate=heat,
        hOverInitial=None if z==1 else beta**(-1/9)))
require('finite exact exhaustion without diameter cutoff',
    abs(remaining_time(1.,1e-11)-1)<1e-12 and rows[-1]['massFraction']==0
    and rows[-1]['normalizedHeatRate']==0 and rows[-1]['hOverInitial'] is None)
# Integrate Q/(M0*hfg), independently of cumulative 1-m bookkeeping.
heatIntegral=quad(lambda z:2.7*integrated_mass(z,1e-11)**(17/27),
    0,1,epsabs=1e-10,epsrel=1e-10)[0]
require('complete latent-energy integral',abs(heatIntegral-1)<1e-9,
    normalizedLatentEnergy=heatIntegral)

results=[]
for o in b['observations']:
    C=.56*o['Re0']**.7*o['Pr']**.5*o['Ja'];end=1/C
    def beta_at(Fo):
        z=Fo/end
        return 0. if z>=1 else integrated_mass(z,1e-11)**(1/3)
    readings=[]
    for r in o['readings']:
        lo,hi=[x*1e-4 for x in r['FoTimes10000']]
        predicted=[beta_at(hi),beta_at(lo)]
        observed=r['beta'];centre=beta_at((lo+hi)/2)
        require('matched source case prediction finite and ordered',
            0<=predicted[0]<=predicted[1]<=1,case=o['id'])
        readings.append(dict(FoTimes10000=r['FoTimes10000'],observedBeta=observed,
            predictedBeta=predicted,centreResidual=centre-sum(observed)/2,
            intersectsReadingBand=predicted[0]<=observed[1] and predicted[1]>=observed[0]))
    results.append(dict(id=o['id'],fluid=o['fluid'],pressure_bar=o['pressure_bar'],
        subcooling_K=o['subcooling_K'],Re0=o['Re0'],Pr=o['Pr'],Ja=o['Ja'],
        extinctionFo=end,extinctionFoTimes10000=end*1e4,
        sourceLifetimeFo=1.784/(o['Re0']**.7*o['Pr']**.5*o['Ja']),
        readings=readings,insideReadingBands=sum(r['intersectsReadingBand'] for r in readings),
        maximumAbsoluteCentreResidual=max(abs(r['centreResidual']) for r in readings)))
print(json.dumps(dict(scope='Chen–Mayinger 1992 equation28 detached temporal event reference',
    packages=dict(python=platform.python_version(),scipy=scipy.__version__),
    sourceEquationReproduced=True,calibrationDataUsed=True,coefficientTuning=False,
    independentEmpiricalValidation=False,waterChannelQualified=False,
    sourceLifetimeOverTemporalLifetime=1.784*.56,
    normalizedLatentEnergy=heatIntegral,trajectory=rows,results=results,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [page, python, ...extra] = process.argv.slice(2)
  if (!page || !python || extra.length)
    throw Error('Usage: reference-design-condensation-temporal.ts <owner-page> <isolated-python>')
  const input = parseCondensationTemporal(await Bun.file(page).text())
  const proc = Bun.spawn([python, '-c', condensationTemporalCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(condensationTemporalCalculation), ...JSON.parse(out) }, null, 2))
}

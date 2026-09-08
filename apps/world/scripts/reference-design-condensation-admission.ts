/** Offline measured-regime comparison. Does not modify the finite bath or runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const interval = z.tuple([positive, positive]).refine(([a, b]) => a < b, 'Require increasing interval')
const schema = z.object({
  design: z.literal('LD-01-condensation-admission'),
  diameterStop_m: z.literal(0.0001),
  observedUpperVelocity_m_s: z.literal(0.25),
  pressureStress_MPa: z.literal(0.1),
  subcoolingStress_K: z.literal(2),
  timeAllowance_ms: z.literal(5),
  observations: z.array(z.object({
    id: z.enum(['c30', 'c50', 'd30', 'd50']),
    pressure_MPa: positive,
    subcooling_K: positive,
    diameter_mm: interval,
    lifetime_ms: interval,
  }).strict()).length(4),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.observations.map(x => x.id)).size !== 4 || b.observations.some(x =>
    x.pressure_MPa <= b.pressureStress_MPa || x.subcooling_K <= b.subcoolingStress_K ||
    x.diameter_mm[0] / 1000 <= b.diameterStop_m))
    ctx.addIssue({ code: 'custom', message: 'Require unique observations and positive admitted bounds' })
})

export function parseCondensationAdmission(document: string) {
  const blocks = [...document.matchAll(/^```reference-condensation-admission\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-condensation-admission block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const condensationAdmissionCalculation = String.raw`
import sys,json,math,platform,time
import numpy as np
import iapws
from iapws import IAPWS97 as W
from scipy.integrate import simpson
b=json.load(sys.stdin);checks=[];start=time.perf_counter()
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))

def pressure_case(p,sub,diameter,mode,nT,nD):
    f=W(P=p,x=0);v=W(P=p,x=1);Ts=f.T;hfg=(v.h-f.h)*1000
    D=np.linspace(b['diameterStop_m'],diameter,nD)
    # This permits the most favorable local bulk temperature at each diameter.
    # It is a numerical envelope, not a new material correlation or bath trajectory.
    maxFlux=np.zeros(nD);maximizer=np.zeros(nD);coldFlux=None;velocity=[]
    for i,T in enumerate(np.linspace(Ts-sub,Ts,nT)):
        l=f if i==nT-1 else W(P=p,T=float(T))
        terminal=math.sqrt(2)*(f.sigma*9.80665*(l.rho-v.rho)/l.rho**2)**.25
        u=terminal if mode=='terminal' else b['observedUpperVelocity_m_s']
        Re=l.rho*u*D/l.mu;Pr=l.cp*1000*l.mu/l.k
        h=l.k/D*(2+.6*np.sqrt(Re)*Pr**(1/3))
        flux=h*(Ts-T)
        if i==0:coldFlux=flux.copy()
        update=flux>maxFlux;maximizer[update]=T;maxFlux=np.maximum(maxFlux,flux)
        velocity.append(u)
    require('positive finite condensation envelope',bool(np.all(np.isfinite(maxFlux)) and np.all(maxFlux>0)))
    # M=rho_v*pi*D^3/6 and Q=pi*D^2*q give dt/dD=rho_v*hfg/(2*q).
    integrand=v.rho*hfg/(2*maxFlux)
    time_ms=float(simpson(integrand,x=D)*1000)
    return dict(time_ms=time_ms,pressure_MPa=p,subcooling_K=sub,diameter_mm=diameter*1000,
        maxEnvelopeOverCold=float(np.max(maxFlux/coldFlux)),
        maxTemperatureAboveCold_K=float(np.max(maximizer-(Ts-sub))),
        velocityRange_m_s=[min(velocity),max(velocity)],
        vaporAtStop_kg=v.rho*math.pi*b['diameterStop_m']**3/6)

def observation(o,mode,nP,nT,nD):
    # D-low is favorable exactly: adding positive integration length only increases time.
    d=o['diameter_mm'][0]/1000
    # Expanded subcooling includes every local T in either nominal or colder bath.
    sub=o['subcooling_K']+b['subcoolingStress_K']
    values=[pressure_case(float(p),sub,d,mode,nT,nD) for p in np.linspace(
        o['pressure_MPa']-b['pressureStress_MPa'],o['pressure_MPa']+b['pressureStress_MPa'],nP)]
    fastest=min(values,key=lambda r:r['time_ms'])
    measuredUpper=o['lifetime_ms'][1]+b['timeAllowance_ms']
    return dict(id=o['id'],mode=mode,fastest=fastest,
        measuredUpperWithAllowance_ms=measuredUpper,
        ratio=fastest['time_ms']/measuredUpper,
        packageFailsDeclaredScreen=fastest['time_ms']>measuredUpper,
        envelopeMaxTemperatureAboveCold_K=max(x['maxTemperatureAboveCold_K'] for x in values))

results=[]
for o in b['observations']:
    for mode in ['terminal','observed_upper']:
        coarse=observation(o,mode,21,33,201)
        fine=observation(o,mode,41,65,401)
        delta=abs(coarse['fastest']['time_ms']-fine['fastest']['time_ms'])
        require('combined quadrature/envelope refinement screen',delta<.01,
            id=o['id'],mode=mode,change_ms=delta)
        nominal=[pressure_case(o['pressure_MPa'],o['subcooling_K'],d/1000,mode,65,401)
            for d in o['diameter_mm']]
        results.append(dict(**fine,nominalIntervalTime_ms=[x['time_ms'] for x in nominal],
            refinementChange_ms=delta))
print(json.dumps(dict(scope='measured disappearance versus favorable spherical-package stop',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__),results=results,
    allObservationsRejectTransferability=all(x['packageFailsDeclaredScreen'] for x in results),
    statisticalConfidenceEstablished=False,isolatedHTCFailureIdentified=False,
    nominalLDChannelQualified=False,checks=checks,wall_s=time.perf_counter()-start),allow_nan=False))
`

if (import.meta.main) {
  const [page, python, ...extra] = process.argv.slice(2)
  if (!page || !python || extra.length)
    throw Error('Usage: reference-design-condensation-admission.ts <owner-page> <isolated-python>')
  const input = parseCondensationAdmission(await Bun.file(page).text())
  const proc = Bun.spawn([python, '-c', condensationAdmissionCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(condensationAdmissionCalculation), ...JSON.parse(out) }, null, 2))
}

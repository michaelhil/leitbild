/** Offline RHR pressure-plane sizing. No transient, controller or live plant. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({
  referencePressure_MPa: positive, referenceTemperature_C: positive,
  pumpReferenceTotal_kg_s: positive, pumpReferenceRise_MPa: positive,
  minimumFlowReference_kg_s: positive, minimumFlowReferenceDrop_MPa: positive,
  sourcePressure_MPa: positive, dischargeEnvelope_MPa: positive,
  selectedEntrySource_MPa: positive, headerTrip_MPa: positive,
  headerReliefOpen_MPa: positive, headerReliefReseat_MPa: positive,
  sourceElevation_m: z.number().finite(), pumpElevation_m: z.number().finite(),
  temperatures_C: z.array(positive.min(40).max(180)).min(2).max(10),
}).strict().superRefine((b, c) => {
  if (b.sourcePressure_MPa >= b.dischargeEnvelope_MPa || b.minimumFlowReference_kg_s >= b.pumpReferenceTotal_kg_s
    || b.sourceElevation_m <= b.pumpElevation_m || new Set(b.temperatures_C).size !== b.temperatures_C.length
    || !(b.selectedEntrySource_MPa < b.headerReliefReseat_MPa && b.headerReliefReseat_MPa < b.headerTrip_MPa
      && b.headerTrip_MPa < b.headerReliefOpen_MPa && b.headerReliefOpen_MPa < b.dischargeEnvelope_MPa))
    c.addIssue({ code: 'custom', message: 'Invalid pressure, flow or datum ordering' })
})

export function parseRhrPressureBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-rhr-pressure\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-rhr-pressure block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const rhrPressureCalculation = String.raw`
import json,sys,platform,math
import numpy as np
import scipy,iapws
from scipy.optimize import brentq
from iapws import IAPWS97 as W
b=json.load(sys.stdin);g=9.80665
def water(p,t):
 w=W(P=float(p),T=float(t)+273.15)
 if w.phase not in ('Liquid','Compressible liquid'):raise ValueError('Outside selected liquid pressure screen')
 return w
ref=water(b['referencePressure_MPa'],b['referenceTemperature_C']);r0=ref.rho
m0=b['pumpReferenceTotal_kg_s'];d0=b['pumpReferenceRise_MPa']
mr=b['minimumFlowReference_kg_s'];dr=b['minimumFlowReferenceDrop_MPa']
def head(m,rho):return rho/r0*d0*(1.25-.25*((m/rho)/(m0/r0))**2)
def minimum(dp,rho):return mr*math.sqrt(rho/r0*dp/dr)
def blocked(p,t):
 rho=water(p,t).rho
 dp=brentq(lambda x:x-head(minimum(x,rho),rho),0.,1.25*d0*rho/r0,xtol=1e-14)
 analytic=(rho/r0)*1.25*d0/(1+.25*d0/dr*(mr/m0)**2)
 if abs(dp-analytic)>1e-12:raise ValueError('Independent pump/minimum-flow root mismatch')
 m=minimum(dp,rho)
 return dict(suction_MPa=p,discharge_MPa=p+dp,head_MPa=dp,minimumFlow_kg_s=m,
   suctionDensity_kg_m3=rho,zeroFlowShutoff_MPa=1.25*d0*rho/r0,analyticRootDifference_MPa=dp-analytic)
def hydro(p0,p1,t,n):
 x,w=np.polynomial.legendre.leggauss(n)
 return (p1-p0)*1e6/2*sum(wi/water((p0+p1)/2+(p1-p0)*xi/2,t).rho for xi,wi in zip(x,w))
dz=b['sourceElevation_m']-b['pumpElevation_m']
def suction(ph,t,n):return brentq(lambda ps:hydro(ph,ps,t,n)-g*dz,ph,ph+.1,xtol=1e-13)
if abs(head(m0,r0)-d0)>1e-12 or abs(minimum(d0,r0)-mr)>1e-12:raise ValueError('Reference identities failed')
rows=[]
for t in b['temperatures_C']:
 ph=b['sourcePressure_MPa'];ps=suction(ph,t,8);r=blocked(ps,t)
 # Mathematical boundary only: no sensing, travel or operating margin.
 # Strictly liquid numerical bracket, not a substituted physical state.
 lower=W(T=t+273.15,x=0).P+1e-8
 if blocked(lower,t)['discharge_MPa']>=b['dischargeEnvelope_MPa']:raise ValueError('No admitted liquid pressure boundary')
 limit=brentq(lambda p:blocked(p,t)['discharge_MPa']-b['dischargeEnvelope_MPa'],lower,b['dischargeEnvelope_MPa'],xtol=1e-13)
 hot=brentq(lambda p:hydro(p,limit,t,8)-g*dz,limit-.1,limit,xtol=1e-13)
 independent=suction(ph,t,16)
 selected=blocked(suction(b['selectedEntrySource_MPa'],t,8),t)
 rows.append(dict(temperature_C=t,source_MPa=ph,**r,
  aboveDischargeEnvelope_MPa=r['discharge_MPa']-b['dischargeEnvelope_MPa'],
  noMarginMaximumSuction_MPa=limit,noMarginMaximumSource_MPa=hot,
  selectedEntry=selected,selectedEntryToHeaderTripMargin_Pa=(b['headerTrip_MPa']-selected['suction_MPa'])*1e6,
  hydrostatic8vs16_Pa=abs(ps-independent)*1e6,
  constantSourceDensityHydroError_Pa=abs(ps-(ph+water(ph,t).rho*g*dz/1e6))*1e6,
  noMarginBoundaryResidual_Pa=abs(blocked(limit,t)['discharge_MPa']-b['dischargeEnvelope_MPa'])*1e6))
if max(r['hydrostatic8vs16_Pa'] for r in rows)>1e-4:raise ValueError('Hydrostatic quadrature screen failed')
# Sampled EOS domain audit, not a proof of global monotonicity or a transient pressure guarantee.
rho_samples=[water(b['dischargeEnvelope_MPa'],float(t)).rho for t in np.linspace(40.,180.,141)]
if any(a<=c for a,c in zip(rho_samples,rho_samples[1:])):raise ValueError('Density ordering failed')
for t in np.linspace(40.,180.,141):
 pp=np.linspace(W(T=float(t)+273.15,x=0).P+1e-8,b['dischargeEnvelope_MPa'],5)
 rr=[water(float(p),float(t)).rho for p in pp]
 if any(a>=c for a,c in zip(rr,rr[1:])):raise ValueError('Pressure-density ordering failed')
shutoff=1.25*d0*rho_samples[0]/r0
legacy=water(1.,125.)
ideal=W(P=b['referencePressure_MPa']+d0,s=ref.s)
print(json.dumps(dict(scope='Static liquid nominal-speed pressure-plane discriminator; external train flow zero, minimum flow open, no transient timing',
 python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__,basis=b,
 referenceDensity_kg_m3=r0,legacy125CDensity_kg_m3=legacy.rho,
 referenceNpshAvailable_m=(b['referencePressure_MPa']-W(T=b['referenceTemperature_C']+273.15,x=0).P)*1e6/(r0*g),
 referenceNpshRequired_m=4.,
 referenceFluidPowerIsentropicEfficiency075_W=m0*(ideal.h-ref.h)*1000/.75,
 legacyIncompressibleFluidPower075_W=m0*d0*1e6/legacy.rho/.75,
 densityAtEnvelope40C_kg_m3=rho_samples[0],
 conservativeNominalSpeedShutoffHead_MPa=shutoff,
 headerTripPlusShutoff_MPa=b['headerTrip_MPa']+shutoff,
 headerReliefThresholdPlusShutoff_MPa=b['headerReliefOpen_MPa']+shutoff,
 nominalSourceStatic150C=blocked(suction(b['referencePressure_MPa'],b['referenceTemperature_C'],8),b['referenceTemperature_C']),
 rows=rows,checks=dict(reference=True,analyticMinimumFlow=True,hydrostaticQuadrature=True,liquidDensityOrdering=True,pressureDensityOrdering=True)),allow_nan=False))
`

export async function runRhrPressure(document: string, python: string) {
  const input = JSON.stringify(parseRhrPressureBasis(document))
  const child = Bun.spawn([python, '-c', rhrPressureCalculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`RHR pressure screen failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(rhrPressureCalculation), sourceSha256: hash(await Bun.file(import.meta.path).text()) }
}

if (import.meta.main) {
  const [owner, python, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || extra.length) throw new Error('Usage: bun reference-design-rhr-pressure.ts <RHR-owner.md> <python-with-iapws>')
  console.log(JSON.stringify(await runRhrPressure(await Bun.file(owner).text(), python), null, 2))
}

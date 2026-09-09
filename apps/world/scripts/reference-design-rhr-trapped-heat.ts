/** Offline rigid-water thermal susceptibility, not a plant heatup trajectory. */
import { createHash } from 'node:crypto'
import { parseRhrAdmissionBasis } from './reference-design-rhr-admission'
import { parseRhrPressureBasis } from './reference-design-rhr-pressure'

export const rhrTrappedHeatCalculation = String.raw`
import json,sys,platform
import numpy as np
import scipy,iapws
from scipy.optimize import brentq
from scipy.integrate import quad
from iapws import IAPWS97 as W
b=json.load(sys.stdin);p=b['pressure'];a=b['admission']
def water(P,T):
 w=W(P=float(P),T=float(T))
 if w.phase not in ('Liquid','Compressible liquid'):raise ValueError('Rigid-water screen outside liquid scope')
 return w
ref=water(p['referencePressure_MPa'],p['referenceTemperature_C']+273.15)
def sample(P0,T0):
 initial=water(P0,T0);rho=initial.rho
 # Constant density on a rigid, fixed-mass isochore: same nominal-speed
 # volumetric pump/MINFLOW intersection as the owner's static screen.
 d0=p['pumpReferenceRise_MPa'];dr=p['minimumFlowReferenceDrop_MPa']
 m0=p['pumpReferenceTotal_kg_s'];mr=p['minimumFlowReference_kg_s']
 head=rho/ref.rho*1.25*d0/(1+.25*d0/dr*(mr/m0)**2)
 q=mr*np.sqrt(rho/ref.rho*head/dr)
 independent_head=rho/ref.rho*d0*(1.25-.25*((q/rho)/(m0/ref.rho))**2)
 if abs(head-independent_head)>1e-12:raise ValueError('Pump intersection mismatch')
 endP=p['dischargeEnvelope_MPa']-head
 if endP<=P0:raise ValueError('Initial pump discharge already at/outside equipment envelope')
 def at(P):
  # Heating at fixed density is liquid for this small-pressure-range screen;
  # the liquid saturation boundary is a numerical bracket, not a thermal sink.
  upper=min(W(P=float(P),x=0).T-1e-6,623.15-1e-6)
  T=brentq(lambda t:water(P,t).rho-rho,T0,upper,xtol=1e-10)
  return water(P,T)
 final=at(endP)
 states=[at(P) for P in np.linspace(P0,endP,17)]
 density_error=max(abs(w.rho-rho) for w in states)
 # Independent thermodynamic differential along rho=constant:
 # dT/dP=kt/alpha (P in MPa), du/dT|rho=cv.
 def differential(P):
  w=at(P)
  return w.cv*1000*w.xkappa/w.alfav
 integral,quadrature_error=quad(differential,P0,endP,epsabs=1e-4,epsrel=1e-10)
 delta_u=(final.u-initial.u)*1000
 discrepancy=abs(delta_u-integral)
 monotone=all(y.T>x.T and y.u>x.u for x,y in zip(states,states[1:]))
 checks=dict(isochoricDensity=bool(density_error<=1e-7),positiveStoredEnergy=bool(delta_u>0),
  differentialIdentity=bool(discrepancy<=.01),monotoneHeating=monotone,
  pressureEnvelope=bool(abs(final.P+head-p['dischargeEnvelope_MPa'])<=1e-10))
 return dict(initialPressure_MPa=P0,initialTemperature_C=T0-273.15,
  density_kg_m3=rho,nominalMinimumFlow_kg_s=float(q),pumpRise_MPa=head,
  initialDischarge_MPa=P0+head,finalSuction_MPa=endP,finalTemperature_C=final.T-273.15,
  temperatureRise_K=final.T-T0,waterInternalEnergyRise_J_kg=delta_u,
  waterInternalEnergyRise_J_per_m3=rho*delta_u,maximumDensityResidual_kg_m3=density_error,
  differentialIntegral_J_kg=integral,differentialDiscrepancy_J_kg=discrepancy,
  quadratureError_J_kg=quadrature_error,checks=checks)
cases=[sample(a['receiverPressure_MPa'],a['receiverTemperature_C']+273.15),
 sample(a['normalPressure_MPa'],a['normalTemperature_C']+273.15)]
rejected=False
try:sample(p['dischargeEnvelope_MPa'],a['receiverTemperature_C']+273.15)
except ValueError as e:
 if 'already at/outside' not in str(e):raise
 rejected=True
if not rejected:raise ValueError('Missing initial-envelope rejection')
print(json.dumps(dict(scope='Rigid fixed-mass liquid susceptibility per participating cubic metre, nominal supported speed; no hardware compliance, wall allocation or time prediction',
 python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__,
 basis=b,cases=cases,checks=dict(initialEnvelopeRejection=rejected),
 accepted=all(all(c['checks'].values()) for c in cases)),allow_nan=False))
`

export async function runRhrTrappedHeat(document: string, python: string) {
  const pressure = parseRhrPressureBasis(document)
  const admission = parseRhrAdmissionBasis(document)
  if (pressure.referencePressure_MPa !== admission.referencePressure_MPa
    || pressure.referenceTemperature_C !== admission.referenceTemperature_C
    || pressure.dischargeEnvelope_MPa !== admission.envelope_MPa)
    throw new Error('RHR pressure and admission owners disagree')
  const input = JSON.stringify({ pressure, admission })
  const source = await Bun.file(import.meta.path).text()
  const child = Bun.spawn([python, '-c', rhrTrappedHeatCalculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`RHR trapped-heat screen failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(rhrTrappedHeatCalculation), sourceSha256: hash(source) }
}

if (import.meta.main) {
  const [owner, python, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || extra.length) throw new Error('Usage: bun reference-design-rhr-trapped-heat.ts <RHR-owner.md> <python-with-iapws>')
  console.log(JSON.stringify(await runRhrTrappedHeat(await Bun.file(owner).text(), python), null, 2))
}

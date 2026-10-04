/** Offline geometry/native-liquid checks. No RHR transient or operating qualification. */
import { createHash } from 'node:crypto'

export function parseWstPaths(document: string) {
  const blocks = [...document.matchAll(/^```reference-rhr-wst-paths\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one RHR WST path record')
  const b = JSON.parse(blocks[0]![1]!)
  for (const key of ['length_m', 'diameter_m', 'referencePressure_Pa', 'referenceTemperature_K', 'referenceFlow_kg_s', 'selectorDrop_Pa', 'fixedDrop_Pa'])
    if (!(Number.isFinite(b[key]) && b[key] > 0)) throw new Error(`Invalid ${key}`)
  if (!Number.isFinite(b.poolMouth_m) || !Number.isFinite(b.trainEnd_m) || b.length_m < Math.abs(b.poolMouth_m-b.trainEnd_m)) throw new Error('Invalid developed geometry')
  if (JSON.stringify(b.trains) !== '["A","B"]') throw new Error('Expected both actual trains')
  return b
}

export const calculation = String.raw`
import json,sys,math,platform
import numpy as np
import CoolProp
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
b=json.load(sys.stdin);g=9.80665;A=math.pi*b['diameter_m']**2/4;V=A*b['length_m']
pr=b['referencePressure_Pa'];tr=b['referenceTemperature_K'];hr=P('H','P',pr,'T',tr,'Water');sr=P('S','P',pr,'T',tr,'Water')
areas=[]
for dp in [b['selectorDrop_Pa'],b['fixedDrop_Pa']]:
 pe=pr-dp;he=P('H','P',pe,'S',sr,'Water');rho=P('D','P',pe,'S',sr,'Water')
 area=b['referenceFlow_kg_s']/(rho*math.sqrt(2*(hr-he)))
 assert 0<area<A
 areas.append(area)
# Declared fixed coupon boundaries, not parsed/current WST preparation qualification.
zsurface=14.148275;psurface=101325.;tsurface=298.15
boundary=dict(surface_m=zsurface,pressure_Pa=psurface,temperature_K=tsurface,meaning='Fixed nominal liquid coupon boundary; not an executed current-preparation or connected-state claim',basis='ld-01/systems/passive-cooling/reservoir-and-containment.md#selected-geometry-and-initial-state')
h0=P('H','P',psurface,'T',tsurface,'Water');s0=P('S','P',psurface,'T',tsurface,'Water');H=h0+g*zsurface
def state(z):
 h=H-g*z
 p=brentq(lambda p:P('H','P',p,'S',s0,'Water')-h,psurface,400000.,xtol=1e-7)
 return p,P('D','P',p,'S',s0,'Water'),P('U','P',p,'S',s0,'Water'),h
def integral(n):
 x,w=np.polynomial.legendre.leggauss(n);mass=energy=0.
 for xx,ww in zip(x,w):
  z=(b['poolMouth_m']+b['trainEnd_m'])/2+xx*(b['poolMouth_m']-b['trainEnd_m'])/2
  p,r,u,h=state(z);mass+=ww*V/2*r;energy+=ww*V/2*r*(u+g*z)
  assert abs(h+g*z-H)<1e-8
 return mass,energy
m8,e8=integral(8);m16,e16=integral(16)
assert abs(m8-m16)<1e-6 and abs(e8-e16)<.1
pm,rm,um,hm=state(b['poolMouth_m']);pt,rt,ut,ht=state(b['trainEnd_m'])
assert pt>pm and abs((ht-hm)+g*(b['trainEnd_m']-b['poolMouth_m']))<1e-8
# Common-datum enthalpy agreement across the hydrostatic profile, not a numerical transfer test.
dm=1.;ein=dm*(hm+g*b['poolMouth_m']);eout=dm*(ht+g*b['trainEnd_m'])
assert abs(ein-eout)<1e-8
assert 2*(b['selectorDrop_Pa']+b['fixedDrop_Pa'])==20000
print(json.dumps(dict(scope='Native liquid calibration and fixed-boundary hydrostatic retained stock; no connected transfer/circulation/priming/pressure trajectory',python=platform.python_version(),CoolProp=CoolProp.__version__,basis=b,boundaryAssumptions=boundary,volumePerLeg_m3=V,addedVolume_m3=4*V,physicalArea_m2=A,effectiveAreas_m2=areas,mouthPressure_Pa=pm,trainEndPressure_Pa=pt,couponMassPerLeg_kg=m16,couponNativeEnergyPerLeg_J=e16,quadratureMassError_kg=abs(m8-m16),quadratureEnergyError_J=abs(e8-e16),hydrostaticTotalEnthalpy_J_kg=H,checks=dict(physicalArea=True,developedGeometry=True,hydrostaticRest=True,commonDatumEnthalpy=True,quadrature=True,lossReplacement=True)),allow_nan=False))
`

export async function runWstPaths(document: string, python: string) {
  const input = JSON.stringify(parseWstPaths(document))
  const child = Bun.spawn([python, '-c', calculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`WST path check failed (${code}): ${err}`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...JSON.parse(out), inputSha256: hash(input), calculationSha256: hash(calculation), sourceSha256: hash(await Bun.file(import.meta.path).text()) }
}
if (import.meta.main) {
  const [owner, python] = Bun.argv.slice(2)
  if (!owner || !python) throw new Error('Usage: bun reference-design-rhr-wst.ts <owner.md> <research-python>')
  console.log(JSON.stringify(await runWstPaths(await Bun.file(owner).text(), python), null, 2))
}

/** Offline collection-law/finite-receipt checks, not a containment trajectory or runtime. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const collectionBasis = {
  upperArea_m2: 12000, lowerArea_m2: 6000, upperOrigin_m: 20, lowerOrigin_m: 6,
  gutterArea_m2: 20, gutterFloor_m: 16, returnCrest_m: 16.02,
  returnWidths_m: [0.25, 0.25], gutterRim_m: 16.5, gutterSpillWidth_m: 1,
  wstRim_m: 15.5, wstSpillWidth_m: 4, weirCoefficient: 1.7,
  dropDiameter_m: 0.001, gravity_m_s2: 9.80665,
} as const

/** Authored dissipative drowned-head extension, not calibrated submerged-weir capacity. */
export function chuteFlow(a: number, b: number, crest: number, width: number) {
  if (![a, b, crest, width].every(Number.isFinite) || width < 0) throw Error('Invalid chute geometry/head')
  return collectionBasis.weirCoefficient * width *
    (Math.max(a - crest, 0) ** 1.5 - Math.max(b - crest, 0) ** 1.5)
}

export function terminalSpeed(d: number, rhoLiquid: number, rhoGas: number, muGas: number) {
  if (![d, rhoLiquid, rhoGas, muGas].every(Number.isFinite) || d <= 0 || rhoLiquid <= rhoGas || rhoGas <= 0 || muGas <= 0) throw Error('Invalid settling material')
  const cdRe = (re: number) => re < 1000 ? 24 * (1 + 0.15 * re ** 0.687) : 0.44 * re
  const balance = (v: number) => 0.75 * muGas * v * cdRe(rhoGas * v * d / muGas) / d ** 2 - (rhoLiquid - rhoGas) * collectionBasis.gravity_m_s2
  let low = 0, high = 1
  while (balance(high) < 0) high *= 2
  for (let n = 0; n < 80; n++) {
    const mid = (low + high) / 2
    if (balance(mid) > 0) high = mid
    else low = mid
  }
  const speed = (low + high) / 2
  return { speed_m_s: speed, reynolds: rhoGas * speed * d / muGas, forceResidual_N_m3: balance(speed) }
}

/** Finite event disposition, never a numerical minimum fall distance. */
export function settlingDisposition(mass: number, surface: number, speed?: number) {
  if (!Number.isFinite(mass) || mass < 0 || !Number.isFinite(surface)) throw Error('Invalid droplet state')
  if (mass === 0) return { mode: 'empty', flow_kg_s: 0 } as const
  if (surface >= collectionBasis.upperOrigin_m) return { mode: 'engulfment', transferredMass_kg: mass } as const
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) throw Error('Missing admitted settling speed')
  return { mode: 'settling', flow_kg_s: mass * speed / (collectionBasis.upperOrigin_m - surface) } as const
}

function hydraulicChecks() {
  const checks: { name: string; value: number; bound: number }[] = []
  const check = (name: string, value: number, bound: number) => {
    if (!Number.isFinite(value) || Math.abs(value) > bound) throw Error(`${name}: ${value}`)
    checks.push({ name, value, bound })
  }
  const b = collectionBasis
  const limits = [
    { name: 'dry', a: 16, r: 14.148275, width: 0.5 },
    { name: 'free return', a: 16.4, r: 14.148275, width: 0.5 },
    { name: 'blocked', a: 16.4, r: 14.148275, width: 0 },
    { name: 'equal drowned head', a: 16.4, r: 16.4, width: 0.5 },
    { name: 'reverse backwater', a: 16.3, r: 16.4, width: 0.5 },
  ].map(c => ({ ...c, flow_m3_s: chuteFlow(c.a, c.r, b.returnCrest_m, c.width) }))
  for (const c of limits) if (c.flow_m3_s * (c.a - c.r) < 0) throw Error('Non-dissipative head direction')
  check('dry origin has no liquid flow', limits[0]!.flow_m3_s, 0)
  check('blocked return', limits[2]!.flow_m3_s, 0)
  check('equal drowned head', limits[3]!.flow_m3_s, 0)
  if (limits[1]!.flow_m3_s <= 0 || limits[4]!.flow_m3_s >= 0) throw Error('Lost physical flow direction')
  check('signed reverse symmetry', chuteFlow(16.4, 16.3, 16.02, 0.5) + limits[4]!.flow_m3_s, 0)
  check('one independently blocked return halves held-head capacity', chuteFlow(16.4, 14.148275, 16.02, 0.25) - limits[1]!.flow_m3_s / 2, 0)
  check('WST at rim has no spill', chuteFlow(15.5, 4, 15.5, 4), 0)
  const wstOverflow_m3_s = chuteFlow(15.6, 4, b.wstRim_m, b.wstSpillWidth_m)
  if (wstOverflow_m3_s <= 0) throw Error('Missing finite WST spill')
  // Deliberately held-density gutter-only balances: finite externally prepared water supply.
  // No gas/shell condensation, pool thermal response or whole network is integrated here.
  const rho = 997.047636760, dt = 0.01, duration = 120, inlet = 200
  const pulses = [0.5, 0].map(width => {
    let retained = 0, returned = 0, spilled = 0, source = inlet * duration
    let firstSpill: number | null = null
    for (let n = 0; n < Math.round(duration / dt); n++) {
      const surface = b.gutterFloor_m + retained / (rho * b.gutterArea_m2)
      const qReturn = rho * chuteFlow(surface, 14.148275, b.returnCrest_m, width)
      const qSpill = rho * chuteFlow(surface, 4, b.gutterRim_m, b.gutterSpillWidth_m)
      if (retained + dt * (inlet - qReturn - qSpill) < 0) throw Error('Step exhausts physical inventory')
      retained += dt * (inlet - qReturn - qSpill)
      returned += dt * qReturn; spilled += dt * qSpill; source -= dt * inlet
      if (qSpill > 0 && firstSpill === null) firstSpill = n * dt
    }
    check(`finite supply ledger width ${width}`, retained + returned + spilled + source - inlet * duration, 1e-7)
    return { openWidth_m: width, sourceRemaining_kg: source, retained_kg: retained, returned_kg: returned, spilled_kg: spilled,
      finalSurface_m: b.gutterFloor_m + retained / (rho * b.gutterArea_m2), firstSpill_s: firstSpill }
  })
  if (pulses[0]!.spilled_kg !== 0 || pulses[1]!.spilled_kg <= 0 || pulses[1]!.returned_kg !== 0) throw Error('Contrary blockage outcome absent')
  const drops = [0.0005, 0.001, 0.002].map(d => {
    const result = terminalSpeed(d, rho, 1.184, 1.85e-5)
    check(`terminal drag balance ${d}`, result.forceResidual_N_m3, 1e-8)
    return { diameter_m: d, ...result, residenceToFloor_s: 16 / result.speed_m_s }
  })
  check('empty cloud skips material properties', settlingDisposition(0, 4).flow_kg_s ?? -1, 0)
  if (settlingDisposition(10, 20).mode !== 'engulfment') throw Error('Missing physical engulfment event')
  return { limits, wstOverflow_m3_s, pulses, drops, checks,
    inputs: { rhoLiquid_kg_m3: rho, rhoGas_kg_m3: 1.184, muGas_Pa_s: 1.85e-5, dt_s: dt, duration_s: duration, finiteSupply_kg: inlet * duration, inlet_kg_s: inlet },
    scope: 'Separate fixed-head limits, held-density gutter-only finite pulse, terminal-size sensitivity; not a coupled CNV trajectory' }
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
b=json.loads(sys.argv[1]);g=b['gravity_m_s2'];p=101325.;checks=[]
def check(name,v,tol):
 if not math.isfinite(v) or abs(v)>tol:raise ValueError((name,v,tol))
 checks.append(dict(name=name,value=v,bound=tol))
def pool(M,T,A,z,datum):
 rho=P('D','P',p,'T',T,'Water');V=M/rho;h=P('H','P',p,'T',T,'Water');u=h-p/rho
 PE=M*g*(z+datum+V/(2*A))
 return dict(M=M,T=T,V=V,PE=PE,U=M*u,E=M*u+PE,surface=z+V/A,h=h)
# Three independent native finite receipts, with no invented receiving temperature.
cases=[]
for initialMass,A,floor,sourceHeight in [(0.,20.,16.,20.),(1000.,20.,16.,20.),(1000.,800.,4.,6.)]:
 for datum in [0.,100.]:
  T0=313.15;dm=1.;h=P('H','P',p,'T',T0,'Water');Ht=h+g*(sourceHeight+datum)
  old=pool(initialMass,T0,A,floor,datum) # dry T only evaluates a zero-mass ledger, not retained state
  target=old['E']+p*old['V']+dm*Ht
  def residual(T):
   q=pool(initialMass+dm,T,A,floor,datum);return q['E']+p*q['V']-target
  T=brentq(residual,T0-1,T0+1,xtol=1e-10)
  q=pool(initialMass+dm,T,A,floor,datum);work=p*(q['V']-old['V'])
  check('native recipient mass',q['M']-old['M']-dm,1e-12)
  check('native recipient totalE plus pressurework',q['E']-old['E']+work-dm*Ht,0.001)
  if T<=T0:raise ValueError('Positive physical fall must not require uphill cooling')
  cases.append(dict(initialMass_kg=initialMass,area_m2=A,floor_m=floor,sourceHeight_m=sourceHeight,datumShift_m=datum,
   receivedMass_kg=dm,sourceHt_J_kg=Ht,pressureWork_J=work,final=q,temperatureRise_K=T-T0))
for i in [0,2,4]:check('native receipt invariant to elevation datum',cases[i]['final']['T']-cases[i+1]['final']['T'],1e-9)
print(json.dumps(dict(scope='Native HEOS finite pool mass/energy/pressurework and dry birth; separate subcooled fixed-pressure receipts, no containment thermal trajectory',
 dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),cases=cases,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [python, output] = process.argv.slice(2)
  if (!python || !output) throw Error('Usage: bun reference-design-containment-collection.ts <research-python> <receipt.json>')
  const owner = resolve(import.meta.dir, '../../../../Leitbild-wiki/world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/reservoir-and-containment.md')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const before = await Bun.file(import.meta.path).text(), ownerBefore = await Bun.file(owner).text()
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(collectionBasis)], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(stderr)
  const native = JSON.parse(stdout), hydraulics = hydraulicChecks()
  if (before !== await Bun.file(import.meta.path).text() || ownerBefore !== await Bun.file(owner).text()) throw Error('Source/owner changed during receipt')
  await Bun.write(output, JSON.stringify({ sourceSha256: hash(before), calculationSha256: hash(calculation),
    ownerContextSha256: hash(ownerBefore), provenance: 'Owner is context, not parsed input; numeric selected basis is the explicit source snapshot below.',
    basis: collectionBasis, hydraulics, native, checkCount: hydraulics.checks.length + native.checks.length }, null, 2) + '\n')
  console.log(JSON.stringify({ output, checks: hydraulics.checks.length + native.checks.length }))
}

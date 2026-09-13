/** Offline gravity-source hydraulic allocation; not an advancing injection model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseBalancePathBasis, checkBalancePath, darcyGradient, type BalancePathBasis } from './reference-design-cmt-balance-path.ts'
import { parseGeometryBasis } from './reference-design-cmt-geometry.ts'
import { parsePrhrGeometry, auditPrhrGeometry } from './reference-design-prhr-geometry.ts'
import { deliveryBasis } from './reference-design-cmt-delivery.ts'
import { hydrostaticLiquidPython } from './reference-design-hydrostatic-liquid.ts'

const positive = z.number().finite().positive()
const branch = z.object({ name: z.enum(['GIV', 'RECIRC']), referenceFlow_kg_s: positive,
  referenceLoss_Pa: positive, checkCrack_Pa: positive }).strict()
const schema = z.object({ waterTemperature_K: positive, gasPressure_Pa: positive,
  sumpFloor_m: z.number().finite(), sumpArea_m2: positive, sumpRim_m: z.number().finite(),
  gravityIntake_m: z.number().finite(), recirculationIntake_m: z.number().finite(), requiredSubmergence_m: positive,
  branches: z.array(branch).length(2), sumpVolumes_m3: z.tuple([positive, positive]), highDowncomerPressure_Pa: positive,
}).strict().refine(b => b.branches.filter(x => x.name === 'GIV').length === 1 && b.branches.filter(x => x.name === 'RECIRC').length === 1,
  'One calibration per installed branch')
export function parseDviCompetition(text: string) {
  const blocks = [...text.matchAll(/^```reference-dvi-competition\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one DVI competition record')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
type Branch = { name: string; sourceHead_Pa: number; resistance_Pa_s2_kg2: number; crack_Pa: number; open: boolean; failedOpen: boolean }
/** Pressure is solved once, not assigned independently to each supplying branch. */
export function gravityCompetition(branches: Branch[], downcomerPressure_Pa: number, neckDrop: (massFlow: number) => number) {
  if (!Number.isFinite(downcomerPressure_Pa) || downcomerPressure_Pa <= 0 || !branches.length ||
    branches.some(b => ![b.sourceHead_Pa, b.resistance_Pa_s2_kg2, b.crack_Pa].every(Number.isFinite) ||
      b.sourceHead_Pa <= 0 || b.resistance_Pa_s2_kg2 <= 0 || b.crack_Pa < 0)) throw Error('Invalid pressure/branch data')
  const flows = (p: number) => branches.map(b => {
    const head = b.sourceHead_Pa - p
    if (!b.open || (!b.failedOpen && head <= b.crack_Pa)) return 0
    return b.failedOpen ? Math.sign(head) * Math.sqrt(Math.abs(head) / b.resistance_Pa_s2_kg2)
      : Math.sqrt((head - b.crack_Pa) / b.resistance_Pa_s2_kg2)
  })
  const residual = (p: number) => p - downcomerPressure_Pa - neckDrop(flows(p).reduce((a, b) => a + b, 0))
  let lo = Math.min(downcomerPressure_Pa, ...branches.map(b => b.sourceHead_Pa))
  let hi = Math.max(downcomerPressure_Pa, ...branches.map(b => b.sourceHead_Pa))
  if (!(residual(lo) <= 0 && residual(hi) >= 0)) throw Error('No shared-pressure bracket between actual source heads')
  for (let n = 0; n < 80 && hi - lo > 1e-9; n++) {
    const mid = (lo + hi) / 2
    if (residual(mid) > 0) hi = mid; else lo = mid
  }
  const pressure = (lo + hi) / 2, rates = flows(pressure), total = rates.reduce((a, b) => a + b, 0)
  const error = residual(pressure)
  if (!Number.isFinite(error) || Math.abs(error) > 1e-5) throw Error('Shared-pressure equation failed')
  return { dviPressure_Pa: pressure, downcomerPressure_Pa, neckFlow_kg_s: total, pressureResidual_Pa: error,
    branches: branches.map((b, i) => ({ ...b, flow_kg_s: rates[i]!,
      state: !b.open ? 'isolated' : rates[i]! > 0 ? 'supplying' : rates[i]! < 0 ? 'backfilling' : 'seated' })) }
}

const propertyCalculation = hydrostaticLiquidPython + String.raw`
import json,sys,platform,CoolProp
d=json.load(sys.stdin)
q=liquid_pt_si(d['pressure'],d['temperature']);_hydrostatic_water.update(CP.PT_INPUTS,d['pressure'],d['temperature'])
result=dict(reference=q,viscosity_Pa_s=_hydrostatic_water.viscosity(),versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__))
if 'cases' in d:
    b=d['delivery'];reservoir=make_liquid_reservoir(b['dviVolume_m3']/(b['dviTop_m']-b['dviBottom_m']),b['dviBottom_m'],b['dviTop_m'],b['dviPort_m'])
    result['finiteDvi']=[]
    for case in d['cases']:
        p=case['dviPressure_Pa'];port=liquid_pt_si(p,d['temperature']);state=reservoir['forward'](p,port['s'])
        result['finiteDvi'].append(dict(name=case['name'],port=port,**{k:v for k,v in state.items() if k!='at'}))
json.dump(result,sys.stdout,indent=2,allow_nan=False)
`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
async function properties(python: string, input: unknown) {
  const proc = Bun.spawn([python, '-c', propertyCalculation], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code) throw Error(err)
  return JSON.parse(out) as { reference: { rho: number }; viscosity_Pa_s: number; finiteDvi?: unknown; versions: unknown }
}
export function commonNeckDrop(b: BalancePathBasis, fixedLoss_Pa: number, rho: number, mu: number, m: number) {
  if (!(fixedLoss_Pa > 0 && rho > 0 && mu > 0)) throw Error('Invalid fixed neck allocation/property')
  return darcyGradient(m, rho, mu, b.dviNeckBore_m, b.roughness_m) * b.dviNeckLength_m +
    fixedLoss_Pa * b.coldDensity_kg_m3 / rho * m * Math.abs(m) / b.dviReferenceFlow_kg_s ** 2
}
if (import.meta.main) {
  const [geometryPath, injectionPath, prhrPath, python, output] = process.argv.slice(2)
  if (!geometryPath || !injectionPath || !prhrPath || !python || !output) throw Error('Usage: dvi-competition geometry.md injection.md prhr.md python output.json')
  const docs = await Promise.all([geometryPath, injectionPath, prhrPath].map(p => Bun.file(p).text()))
  const geometry = parseGeometryBasis(docs[0]!), path = parseBalancePathBasis(docs[0]!), basis = parseDviCompetition(docs[1]!)
  const delivery = deliveryBasis(docs[1]!), prhr = parsePrhrGeometry(docs[2]!), bank = auditPrhrGeometry(prhr)
  const allocated = checkBalancePath(geometry, path).dviNeck
  const sources = [import.meta.path, ...['reference-design-cmt-balance-path.ts', 'reference-design-cmt-geometry.ts', 'reference-design-prhr-geometry.ts',
    'reference-design-cmt-delivery.ts', 'reference-design-hydrostatic-liquid.ts'].map(p => new URL(p, import.meta.url).pathname)]
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p.split('/').at(-1)!, hash(await Bun.file(p).text())])))
  const prop = await properties(python, { pressure: basis.gasPressure_Pa, temperature: basis.waterTemperature_K })
  const rho = prop.reference.rho, mu = prop.viscosity_Pa_s, g = 9.80665
  const neckDrop = (m: number) => commonNeckDrop(path, allocated.discharge_Pa + allocated.fictionalRemainder_Pa, rho, mu, m)
  const cases = []
  for (const config of [{ name: 'WST-only', volume: basis.sumpVolumes_m3[0], sumpOpen: false, failed: false },
    { name: 'both-healthy', volume: basis.sumpVolumes_m3[0], sumpOpen: true, failed: false },
    { name: 'weak-sump-healthy', volume: basis.sumpVolumes_m3[1], sumpOpen: true, failed: false },
    { name: 'weak-sump-failed-check', volume: basis.sumpVolumes_m3[1], sumpOpen: true, failed: true },
    { name: 'high-downcomer-healthy', volume: basis.sumpVolumes_m3[0], sumpOpen: true, failed: false, dc: basis.highDowncomerPressure_Pa }]) {
    const wstVolume = prhr.pool.initialWater_m3 - config.volume
    const wstLevel = prhr.pool.floor_m + wstVolume / bank.pool.area_m2, sumpLevel = basis.sumpFloor_m + config.volume / basis.sumpArea_m2
    if (!(wstVolume > 0 && wstLevel < bank.pool.lastWetting_m && sumpLevel <= basis.sumpRim_m &&
      wstLevel > basis.gravityIntake_m + basis.requiredSubmergence_m && sumpLevel > basis.recirculationIntake_m + basis.requiredSubmergence_m))
      throw Error('Fixture needs actual partial hardware/intersection or intake phase treatment')
    const branches = basis.branches.map(b => ({ name: b.name, sourceHead_Pa: basis.gasPressure_Pa + rho * g * ((b.name === 'GIV' ? wstLevel : sumpLevel) - delivery.dviPort_m),
      resistance_Pa_s2_kg2: b.referenceLoss_Pa / b.referenceFlow_kg_s ** 2, crack_Pa: b.checkCrack_Pa,
      open: b.name === 'GIV' || config.sumpOpen, failedOpen: b.name === 'RECIRC' && config.failed }))
    cases.push({ name: config.name, wstVolume_m3: wstVolume, sumpVolume_m3: config.volume, wstLevel_m: wstLevel, sumpLevel_m: sumpLevel,
      waterMass_kg: (wstVolume + config.volume) * rho, ...gravityCompetition(branches, config.dc ?? basis.gasPressure_Pa, neckDrop) })
  }
  const native = await properties(python, { pressure: basis.gasPressure_Pa, temperature: basis.waterTemperature_K, delivery, cases })
  for (const p of sources) if (hash(await Bun.file(p).text()) !== sourceHashes[p.split('/').at(-1)!]) throw Error('Source changed during comparison')
  const input = { geometry, path, basis, delivery, prhr }
  await Bun.write(output, JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), sourceHashes, calculationHash: hash(propertyCalculation),
    properties: prop, cases, finiteDvi: native.finiteDvi,
    scope: 'Shared liquid hydraulic snapshots with finite DVI state; not thermal equilibrium, accident reachability, phase allocation, or time advancement' }, null, 2) + '\n')
}

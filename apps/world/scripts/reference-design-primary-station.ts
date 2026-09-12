/** Offline fixed-state cycle reconciliation. No finite-secondary initialization or live plant. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle'
import { runPrimaryOperatingPoint } from './reference-design-primary-operating-point'
import { calculateStation, parseStationBasis } from './reference-design-station'
import { parseSupportBasis, selectSupportPoint, sizeSupportJackets, type Branch } from './reference-design-support-network'

const positive = z.number().finite().positive()
const boundarySchema = z.object({ sourceHeat_W: positive, shaftToFluid_W: positive, electricalInput_W: positive,
  perSGHeat_W: positive, independentSGHeat_W: positive }).strict().refine(v => v.electricalInput_W >= v.shaftToFluid_W,
  'Electrical input must pay fluid work and losses')
type Boundary = z.infer<typeof boundarySchema>
const secondaryKeys = ['turbine_thermodynamic_work', 'gross_electric', 'condenser', 'feed_pump_fluid',
  'feed_pump_electric', 'condensate_pump_fluid', 'condensate_pump_electric', 'regenerated_feed_heat'] as const

/** The owning cycle solves extraction fractions per kg. At unchanged thermodynamic
 * states, these named extensive duties scale exactly with steam throughput.
 * This is not a generic off-design turbine/pump or pressure-control model. */
export function reconcileFixedCycle(reference: { powers_MW: Record<string, number>; flows: { SG_total_kg_s: number } }, supplied: Boundary) {
  const boundary = boundarySchema.parse(supplied), previous = reference.powers_MW
  for (const key of ['SG_total', ...secondaryKeys]) positive.parse(previous[key])
  positive.parse(reference.flows.SG_total_kg_s)
  const duty = (boundary.sourceHeat_W + boundary.shaftToFluid_W) / 1e6
  const primaryResidual_W = duty * 1e6 - 2 * boundary.perSGHeat_W
  const primaryQuadratureResidual_W = duty * 1e6 - 2 * boundary.independentSGHeat_W
  if (Math.max(Math.abs(primaryResidual_W), Math.abs(primaryQuadratureResidual_W)) >= 10)
    throw Error('Supplied primary failed its 10 W heat/shaft gate')
  const scale = duty / previous.SG_total!
  const powers: Record<string, number> = Object.fromEntries(secondaryKeys.map(key => [key, previous[key]! * scale]))
  Object.assign(powers, { core: boundary.sourceHeat_W / 1e6, RCP_fluid: boundary.shaftToFluid_W / 1e6,
    RCP_electric: boundary.electricalInput_W / 1e6, SG_total: duty })
  powers.electrical_after_listed_pumps = powers.gross_electric! - powers.RCP_electric! - powers.feed_pump_electric! - powers.condensate_pump_electric!
  const secondaryResidual_MW = duty + powers.feed_pump_fluid! + powers.condensate_pump_fluid!
    - powers.turbine_thermodynamic_work! - powers.condenser!
  if (Math.abs(secondaryResidual_MW) > 1e-8) throw Error('Fixed-state secondary first law does not close')
  return { powers_MW: powers, steamFlow_kg_s: reference.flows.SG_total_kg_s * scale,
    scale, primaryResidual_W, primaryQuadratureResidual_W, secondaryResidual_MW }
}

/** Transfer duties by exact equipment identity; preserve already selected hydraulic hardware. */
export function applyJacketLoads(sized: Branch[], loaded: Branch[]): Branch[] {
  const loads = new Map(loaded.map(v => [v.id, v.heat_MW]))
  if (loads.size !== loaded.length || loads.size !== sized.length || new Set(sized.map(v => v.id)).size !== sized.length)
    throw Error('Jacket identity mismatch')
  return sized.map(v => {
    const heat_MW = loads.get(v.id)
    if (heat_MW === undefined || !Number.isFinite(heat_MW) || heat_MW < 0) throw Error('Missing valid jacket duty')
    return { ...v, heat_MW }
  })
}

export async function runPrimaryStation(wiki: string, python: string) {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceFiles = ['reference-design-primary-station.ts', 'reference-design-station.ts', 'reference-design-support-network.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name,
    hash(await Bun.file(new URL(name, import.meta.url)).text())])))
  const read = (path: string) => Bun.file(join(wiki, path)).text()
  const [cycleDoc, stationDoc, supportDoc] = await Promise.all([
    read('systems/steam-power/cycle-basis.md'), read('model/station-balance.md'), read('systems/support-services/thermal-water-and-air.md')])
  const reference = await runCycle(cycleDoc, python)
  const primary = await runPrimaryOperatingPoint(wiki, python, 'nominal')
  if (!primary.accepted || !primary.result) throw Error('Current primary operating point was not accepted')
  const r = primary.result
  const coreHeatConvention = r.sourceHalfHeat_W.map((source_W: number, i: number) => {
    const inlet = r.coreFaces[i], outlet = r.coreFaces[i + 1]
    const enthalpyOnly_W = r.coreFlow_kg_s * (outlet.h_J_kg - inlet.h_J_kg)
    const totalEnthalpy_W = r.coreFlow_kg_s * (outlet.totalEnthalpy_J_kg - inlet.totalEnthalpy_J_kg)
    if (Math.abs(totalEnthalpy_W - source_W) >= 10) throw Error('Primary core total-enthalpy reciprocity failed')
    return { half: i + 1, source_W, enthalpyOnly_W, totalEnthalpy_W,
      omittedKineticAndGravity_W: totalEnthalpy_W - enthalpyOnly_W }
  })
  const supplied = { sourceHeat_W: r.sourceHeat_W, shaftToFluid_W: r.shaftToFluid_W, electricalInput_W: r.electricalInput_W,
    perSGHeat_W: r.perSGHeat_W, independentSGHeat_W: r.independentSGHeat_W }
  const cycle = reconcileFixedCycle(reference, supplied)
  const stationBasis = parseStationBasis(stationDoc), supportBasis = parseSupportBasis(supportDoc)
  if (stationBasis.shaftMechanicalEfficiency !== reference.basis.shaftMechanicalEfficiency) throw Error('Shaft efficiency ownership mismatch')
  const sized = sizeSupportJackets(supportBasis, stationBasis, reference)
  const sizedCWFlow = calculateStation(stationBasis, reference).flows_kg_s.CW
  // The second call supplies heat distribution only. Its new sizing flows are
  // deliberately not installed; the first design's actual resistances remain.
  const loads = sizeSupportJackets(supportBasis, stationBasis, cycle)
  const jackets = { A: applyJacketLoads(sized.A, loads.A), B: applyJacketLoads(sized.B, loads.B) }
  const aggregate = calculateStation(stationBasis, cycle, undefined, sizedCWFlow)
  const normal = (train: 'A' | 'B', branches: Branch[]) => selectSupportPoint(supportBasis, stationBasis, branches,
    stationBasis.siteWater_C, aggregate.pumps[train === 'A' ? 'SWA' : 'SWB'].fluid_MW * 1e6
      / (stationBasis.waterCp_J_kgK * stationBasis.SW[train === 'A' ? 'flowA_kg_s' : 'flowB_kg_s']))
  const A = normal('A', jackets.A), B = normal('B', jackets.B)
  if (!A.targetAchievable || !B.targetAchievable) throw Error('Existing support hardware cannot attain its selected normal target')
  const alignment = { A: { flow_kg_s: A.point.flow_kg_s, head_MPa: A.point.head_MPa },
    B: { flow_kg_s: B.point.flow_kg_s, head_MPa: B.point.head_MPa } }
  const station = calculateStation(stationBasis, cycle, alignment, sizedCWFlow)
  const checks = {
    stationarySecondaryEnergy: Math.abs(cycle.secondaryResidual_MW) < 1e-8,
    stationaryWholeBudget: Math.abs(station.powers_MW.residual) < 1e-8,
    supportHeatA: Math.abs(station.powers_MW.CCW_A_heat - A.point.heat_MW) < 1e-9,
    supportHeatB: Math.abs(station.powers_MW.CCW_B_heat - B.point.heat_MW) < 1e-9,
    frozenCWFlow: station.flows_kg_s.CW === sizedCWFlow,
    frozenHardware: (['A', 'B'] as const).every(train => jackets[train].every((v, i) =>
      v.reference_kg_s === sized[train][i]!.reference_kg_s && v.conductance_MW_K === sized[train][i]!.conductance_MW_K)),
  }
  if (Object.values(checks).some(v => !v)) throw Error('Current primary/station reconciliation failed')
  for (const name of sourceFiles) if (hash(await Bun.file(new URL(name, import.meta.url)).text()) !== sourceHashes[name])
    throw Error('Calculation source changed during this run; discard and repeat')
  return { scope: 'Current main-primary duty into fixed-state regenerative cycle and fixed support hardware; no PZR thermal exchange or finite-secondary initialization',
    sources: sourceHashes, inputHash: hash(JSON.stringify({ stationBasis, supportBasis, supplied })),
    coreHeatConvention, referenceCycle: reference, primaryIdentity: { source: primary.sourceSha256, calculation: primary.calculationSha256,
      input: primary.inputSha256, dependencies: primary.dependencies }, supplied, sizedJackets: sized, jackets,
    cycle, support: { A, B }, station, checks, liveModelInstalled: false }
}
if (import.meta.main) {
  const [wiki, python, ...extra] = Bun.argv.slice(2)
  if (!wiki || !python || extra.length) throw Error('Usage: primary-station.ts <LD-01-directory> <research-python>')
  console.log(JSON.stringify(await runPrimaryStation(wiki, python), null, 2))
}

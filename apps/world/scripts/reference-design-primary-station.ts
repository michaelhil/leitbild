/** Offline fixed-state cycle reconciliation. No finite-secondary initialization or live plant. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle'
import { runPrimaryOperatingPoint } from './reference-design-primary-operating-point'
import { calculateStation, parseStationBasis } from './reference-design-station'
import { parseSupportBasis, selectSupportPoint, sizeSupportJackets, type Branch } from './reference-design-support-network'
import { parseHydraulicBasis } from './reference-design-hydraulics'

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

/** A connection ledger, NOT a solved new primary/station operating point. The
 * secondary states and support-pump work are held only for this allocation. */
export function auditPzrInterface(input: {
  coreFlow_kg_s: number; hotAFlow_kg_s: number; bypassFlow_kg_s: number;
  coldTotalEnthalpy_J_kg: number; returnTotalEnthalpy_J_kg: number;
  heater_W: number; ambient_W: number; reportedPrimaryReturn_W: number;
  secondary: Record<string, number>; shaftEfficiency: number; transformerLossFraction: number;
}) {
  const v = z.object({ coreFlow_kg_s: positive, hotAFlow_kg_s: positive, bypassFlow_kg_s: positive,
    coldTotalEnthalpy_J_kg: z.number().finite(), returnTotalEnthalpy_J_kg: z.number().finite(),
    heater_W: positive, ambient_W: positive, reportedPrimaryReturn_W: z.number().finite(),
    secondary: z.record(z.string(), z.number().finite()), shaftEfficiency: positive.max(1),
    transformerLossFraction: z.number().finite().nonnegative() }).strict().parse(input)
  if (v.hotAFlow_kg_s >= v.coreFlow_kg_s) throw Error('Both main-loop paths require positive flow')
  for (const k of ['SG_total', ...secondaryKeys]) positive.parse(v.secondary[k])
  if (v.secondary.feed_pump_electric! < v.secondary.feed_pump_fluid!
    || v.secondary.condensate_pump_electric! < v.secondary.condensate_pump_fluid!
    || v.secondary.gross_electric! > v.secondary.turbine_thermodynamic_work! * v.shaftEfficiency)
    throw Error('Base secondary equipment has negative conversion losses')
  const q = v.bypassFlow_kg_s, a = v.hotAFlow_kg_s, b = v.coreFlow_kg_s - a
  const primaryReturn_W = q * (v.returnTotalEnthalpy_J_kg - v.coldTotalEnthalpy_J_kg)
  const sideEnergyResidual_W = v.heater_W - v.ambient_W - primaryReturn_W
  if (Math.abs(sideEnergyResidual_W) >= 10 || Math.abs(primaryReturn_W - v.reportedPrimaryReturn_W) >= 10)
    throw Error('PZR physical port energy disagrees with the retained 10 W boundary gate')
  const ratio = primaryReturn_W / (v.secondary.SG_total! * 1e6)
  if (ratio <= -1) throw Error('Conditional allocation requires positive resulting steam throughput')
  const delta = Object.fromEntries(secondaryKeys.map(k => [k, v.secondary[k]! * 1e6 * ratio]))
  // Reuse the station owner's actual heat destinations; do not subtract the
  // heater as exported energy or send all of its electrical input to ambient.
  const feedLoss = delta.feed_pump_electric! - delta.feed_pump_fluid!
  const condensateLoss = delta.condensate_pump_electric! - delta.condensate_pump_fluid!
  const oil = delta.turbine_thermodynamic_work! * (1 - v.shaftEfficiency)
  const generator = delta.turbine_thermodynamic_work! * v.shaftEfficiency - delta.gross_electric!
  const busA = v.heater_W + delta.feed_pump_electric! / 2 + delta.condensate_pump_electric!
  const busB = delta.feed_pump_electric! / 2, transformer = (busA + busB) * v.transformerLossFraction
  const net = delta.gross_electric! - busA - busB - transformer
  const cw = delta.condenser!, swA = feedLoss / 2 + condensateLoss, swB = feedLoss / 2 + oil + generator
  const ambient = v.ambient_W + transformer
  const allocationResidual_W = net + cw + swA + swB + ambient
  // The allocation inherits the measured side-path residual, rather than
  // forcing that residual to zero with a manufactured heat source.
  if (Math.abs(allocationResidual_W + sideEnergyResidual_W) > 1e-6)
    throw Error('Conditional station allocation does not conserve the same energy')
  return { scope: 'Stationary port-incidence and conditional power allocation only; no joined operating point, controller or phase-rate qualification',
    flows_kg_s: { core: a + b, hotABeforeTee: a, hotAAfterTee: a + q, SGA: a + q,
      eachRcpA: (a + q) / 2, coldAToDowncomer: a, bypass: q, surgeReturn: q, hotBAndSGB: b },
    massResiduals_kg_s: { hotATee: a + q - (a + q), coldA: (a + q) - a - q, downcomer: a + b - v.coreFlow_kg_s },
    primaryReturn_W, sideEnergyResidual_W, conditionalSecondaryThroughputFraction: ratio,
    conditionalIncrements_W: { gross: delta.gross_electric!, busA, busB, transformer, netExport: net,
      condenserSiteRejection: cw, SW_A_rejection: swA, SW_B_rejection: swB, ambientRejection: ambient, allocationResidual: allocationResidual_W },
    heaterOnlySubtractionError_W: net + v.heater_W,
    coupledHydraulicsSolved: false, radialBaselineRefreshed: false }
}

export function assertPzrEvidenceLineage(station: unknown, primary: unknown, thermal: unknown) {
  const digest = z.string().regex(/^[a-f0-9]{64}$/)
  const identity = z.object({ sourceSha256: digest, calculationSha256: digest, inputSha256: digest })
  const { accepted: _, ...expected } = identity.extend({ accepted: z.literal(true) }).parse(primary)
  const parent = z.object({ parentIdentities: z.object({ primary: identity }) }).parse(thermal).parentIdentities.primary
  const s = z.object({ primaryIdentity: z.object({ source: digest, calculation: digest, input: digest }),
    checks: z.record(z.string(), z.literal(true)).refine(v => Object.keys(v).length > 0) }).parse(station)
  if (Object.entries(expected).some(([k, v]) => parent[k as keyof typeof parent] !== v)
    || s.primaryIdentity.source !== expected.sourceSha256 || s.primaryIdentity.calculation !== expected.calculationSha256
    || s.primaryIdentity.input !== expected.inputSha256) throw Error('Mismatched primary/station/PZR evidence')
  return expected
}

/** Retained receipts carry their own source identity. Do not require old
 * evidence to pretend it was generated by today's source file. */
export async function runPzrInterfaceAudit(stationPath: string, primaryPath: string, thermalPath: string, wiki: string) {
  const raw = await Promise.all([stationPath, primaryPath, thermalPath].map(p => Bun.file(p).text()))
  const [station, primary, thermal] = raw.map(s => JSON.parse(s))
  const expected = assertPzrEvidenceLineage(station, primary, thermal)
  const cold = primary.result.mixing.filter((v: { owner: string }) => v.owner === 'COLD.A/B')
  if (cold.length !== 1) throw Error('Expected one source-owned cold-header reference')
  const [hydraulicDoc, stationDoc] = await Promise.all(['model/primary-hydraulic-basis.md', 'model/station-balance.md']
    .map(p => Bun.file(join(wiki, p)).text()))
  const gravity = parseHydraulicBasis(hydraulicDoc!).gravity_m_s2, basis = parseStationBasis(stationDoc!)
  const normal = thermal.cases[0]
  if (!normal?.hydraulicAdmission || !normal.energyAccountingAdmission || normal.effectiveThermalConductanceMultiplier !== 1)
    throw Error('Expected admitted normal required-duty comparison')
  const input = { coreFlow_kg_s: primary.result.coreFlow_kg_s, hotAFlow_kg_s: primary.result.coreFlow_kg_s / 2,
    bypassFlow_kg_s: normal.q, coldTotalEnthalpy_J_kg: cold[0].h + gravity * cold[0].reference_m,
    returnTotalEnthalpy_J_kg: normal.surge.outlet.H, heater_W: normal.requiredHeater_W,
    ambient_W: normal.totalAmbient_W, reportedPrimaryReturn_W: normal.primaryThermalReturn_W,
    secondary: station.cycle.powers_MW, shaftEfficiency: basis.shaftMechanicalEfficiency,
    transformerLossFraction: basis.transformerLoadFraction }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { sourceSha256: hash(await Bun.file(import.meta.path).text()), receiptHashes: raw.map(hash),
    parentPrimary: expected, inputSha256: hash(JSON.stringify(input)), input, ...auditPzrInterface(input) }
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
  if (Bun.argv[2] === 'pzr-interface') {
    const [, station, primary, thermal, wiki, ...extra] = Bun.argv.slice(2)
    if (!station || !primary || !thermal || !wiki || extra.length) throw Error('Usage: primary-station.ts pzr-interface <station.json> <primary.json> <thermal.json> <LD-01-directory>')
    console.log(JSON.stringify(await runPzrInterfaceAudit(station, primary, thermal, wiki), null, 2))
  } else {
    const [wiki, python, ...extra] = Bun.argv.slice(2)
    if (!wiki || !python || extra.length) throw Error('Usage: primary-station.ts <LD-01-directory> <research-python>')
    console.log(JSON.stringify(await runPrimaryStation(wiki, python), null, 2))
  }
}

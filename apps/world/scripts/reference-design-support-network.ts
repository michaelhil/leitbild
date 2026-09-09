/** Offline selected CCW branch sizing and steady mixing reference, not runtime physics. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle'
import { calculateStation, parseStationBasis, pumpDuty } from './reference-design-station'

const positive = z.number().finite().positive()
const schema = z.object({ jacketDesignRise_K: positive, minimumBranch_kg_s: positive, localDesignDrop_MPa: positive,
  coolerFixedDrop_MPa: positive, coolerValveDrop_MPa: positive, bypassFixedDrop_MPa: positive, bypassValveDrop_MPa: positive,
  exchangerSide_MW_K: positive, serviceExchangerFlow_kg_s: positive, rhrReference_kg_s: positive, rhrLoad_MW: positive,
  jacket_MW_K: z.object({ rcp: positive, feed: positive, small: positive, oil: positive }).strict(),
}).strict()
export function parseSupportBasis(page: string) {
  const blocks = [...page.matchAll(/^```reference-support-network\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-support-network block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
type Basis = z.infer<typeof schema>
type Station = ReturnType<typeof parseStationBasis>
export type Branch = { id: string; heat_MW: number; reference_kg_s: number; conductance_MW_K: number }
function bisect(f: (x: number) => number, lo: number, hi: number) {
  if (!(f(lo) <= 0 && f(hi) >= 0)) throw Error('Support root is not bracketed')
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if (f(mid) < 0) lo = mid; else hi = mid }
  return (lo + hi) / 2
}
export function supportPoint(b: Basis, s: Station, branches: Branch[], bypass: number, site_C: number, swInletRise_K: number, rhr: boolean, blocked?: string) {
  if (!Number.isFinite(bypass) || bypass < 0 || bypass > 1 || !Number.isFinite(site_C) || !Number.isFinite(swInletRise_K)) throw Error('Invalid support boundary')
  const rated = s.CCW.ratedFlow_kg_s, cp = s.waterCp_J_kgK, rho = s.waterDensity_kg_m3
  const active = branches.filter(v => v.id !== blocked)
  const sumReference = active.reduce((a, v) => a + v.reference_kg_s, 0) + (rhr ? b.rhrReference_kg_s : 0)
  if (sumReference <= 0) throw Error('No selected positive-flow CCW path')
  const localK = b.localDesignDrop_MPa / sumReference ** 2
  const hxC = bypass === 1 ? 0 : rated / Math.sqrt(b.coolerFixedDrop_MPa + b.coolerValveDrop_MPa / (1 - bypass) ** 2)
  const byC = bypass === 0 ? 0 : rated / Math.sqrt(b.bypassFixedDrop_MPa + b.bypassValveDrop_MPa / bypass ** 2)
  const commonK = 1 / (hxC + byC) ** 2
  const m = Math.sqrt(1.25 * s.CCW.head_MPa / (localK + commonK + .25 * s.CCW.head_MPa / rated ** 2))
  const head = s.CCW.head_MPa * (1.25 - .25 * (m / rated) ** 2)
  const pump = pumpDuty(m, head, rho, s.CCW.hydraulicEfficiency, s.CCW.motorEfficiency, s.CCW.dragFraction)
  const hxFlow = bypass === 0 ? m : bypass === 1 ? 0 : m * hxC / (hxC + byC), bypassFlow = m - hxFlow
  const loads = branches.reduce((a, v) => a + v.heat_MW, 0) + (rhr ? b.rhrLoad_MW : 0)
  const totalHeat = loads + pump.fluid_MW
  const feasible = !(blocked && branches.find(v => v.id === blocked)!.heat_MW > 0) && hxFlow > 0
  const cpMW = cp / 1e6, swFlow = b.serviceExchangerFlow_kg_s
  // Supply mixed cell -> pump -> jackets -> return header -> parallel cooler/bypass.
  const swOutlet = site_C + swInletRise_K + totalHeat / (swFlow * cpMW)
  const wall = swOutlet + totalHeat / b.exchangerSide_MW_K
  const cooled = wall + totalHeat / b.exchangerSide_MW_K
  const returned = feasible ? cooled + totalHeat / (hxFlow * cpMW) : null
  const supply = returned === null ? null : returned - totalHeat / (m * cpMW)
  const inlet = supply === null ? null : supply + pump.fluid_MW / (m * cpMW)
  const details = branches.map(v => {
    const flow = v.id === blocked ? 0 : m * v.reference_kg_s / sumReference
    const water = flow > 0 && inlet !== null ? inlet + v.heat_MW / (flow * cpMW) : null
    return { ...v, flow_kg_s: flow, outlet_C: water, metal_C: water === null ? null : water + v.heat_MW / v.conductance_MW_K }
  })
  const rhrFlow = rhr ? m * b.rhrReference_kg_s / sumReference : 0
  const pressureResidual_MPa = head - (localK + commonK) * m ** 2
  const flowResidual_kg_s = m - details.reduce((a, v) => a + v.flow_kg_s, 0) - rhrFlow
  const energyResidual_MW = returned === null || supply === null ? null : m * cpMW * (returned - supply) - totalHeat
  if (Math.abs(pressureResidual_MPa) > 1e-10 || Math.abs(flowResidual_kg_s) > 1e-9 || (energyResidual_MW !== null && Math.abs(energyResidual_MW) > 1e-9)) throw Error('Support balance did not close')
  return { bypass, feasible, reason: feasible ? null : blocked ? 'Heat-producing jacket has no throughflow; no selected ambient sink' : 'No cooler throughflow',
    flow_kg_s: m, head_MPa: head, localDrop_MPa: localK * m * m, commonDrop_MPa: commonK * m * m,
    hxFlow_kg_s: hxFlow, bypassFlow_kg_s: bypassFlow, rhrFlow_kg_s: rhrFlow, pump,
    heat_MW: totalHeat, temperatures_C: { supply, loadInlet: inlet, return: returned, coolerOutlet: feasible ? cooled : null, wall: feasible ? wall : null, swOutlet: feasible ? swOutlet : null }, branches: details,
    pressureResidual_MPa, flowResidual_kg_s, energyResidual_MW }
}

export function selectSupportPoint(b: Basis, s: Station, branches: Branch[], site_C: number, swInletRise_K: number, rhr = false) {
  const point = (x: number) => supportPoint(b, s, branches, x, site_C, swInletRise_K, rhr)
  const coldest = point(0), target = s.CCW.supply_C
  if (coldest.temperatures_C.supply! > target) return { targetAchievable: false, controller: 'full cooling saturated', point: coldest }
  const position = bisect(x => x === 1 ? Infinity : point(x).temperatures_C.supply! - target, 0, 1)
  return { targetAchievable: true, controller: 'zero-error integral equals achieved bypass position', point: point(position) }
}

export async function runSupport(owner: string, stationOwner: string, cycleOwner: string, python: string) {
  const b = parseSupportBasis(await Bun.file(owner).text()), s = parseStationBasis(await Bun.file(stationOwner).text())
  const cycle = await runCycle(await Bun.file(cycleOwner).text(), python), old = calculateStation(s, cycle), P = cycle.powers_MW
  const reference = (id: string, heat_MW: number, conductance_MW_K: number): Branch => ({ id, heat_MW, conductance_MW_K,
    reference_kg_s: Math.max(b.minimumBranch_kg_s, heat_MW * 1e6 / s.waterCp_J_kgK / b.jacketDesignRise_K) })
  const rc = (P.RCP_electric! - P.RCP_fluid!) / 4, fw = (P.feed_pump_electric! - P.feed_pump_fluid!) / 2
  const G = b.jacket_MW_K
  const A = [reference('RCP.A1', rc, G.rcp), reference('RCP.B1', rc, G.rcp), reference('FW.P1', fw, G.feed),
    reference('COND.P', P.condensate_pump_electric! - P.condensate_pump_fluid!, G.small), reference('CHARGE.P', 0, G.small)]
  const B = [reference('RCP.A2', rc, G.rcp), reference('RCP.B2', rc, G.rcp), reference('FW.P2', fw, G.feed), reference('TG.OIL', old.powers_MW.oilLoss, G.oil)]
  const swRise = (train: 'A' | 'B') => old.pumps[train === 'A' ? 'SWA' : 'SWB'].fluid_MW * 1e6 / (s.waterCp_J_kgK * s.SW[train === 'A' ? 'flowA_kg_s' : 'flowB_kg_s'])
  const normalA = selectSupportPoint(b, s, A, s.siteWater_C, swRise('A')), normalB = selectSupportPoint(b, s, B, s.siteWater_C, swRise('B'))
  const cases = { normalA, normalB, warmA: selectSupportPoint(b, s, A, 35, swRise('A')), warmB: selectSupportPoint(b, s, B, 35, swRise('B')),
    rhrDutyA: selectSupportPoint(b, s, A, s.siteWater_C, swRise('A'), true), rhrDutyB: selectSupportPoint(b, s, B, s.siteWater_C, swRise('B'), true),
    blockedOil: supportPoint(b, s, B, normalB.point.bypass, s.siteWater_C, swRise('B'), false, 'TG.OIL') }
  const checks = { nominalTargets: normalA.targetAchievable && normalB.targetAchievable,
    warmerSourceCannotReachTarget: !cases.warmA.targetAchievable && !cases.warmB.targetAchievable,
    noBlockedJacketSteady: !cases.blockedOil.feasible,
    actualPumpCompetition: cases.rhrDutyB.point.rhrFlow_kg_s < b.rhrReference_kg_s,
    preserveUnequalDuties: normalA.point.flow_kg_s !== normalB.point.flow_kg_s }
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')
  return { scope: 'Offline constant-property support sizing on retained station/cycle duties, not new-core or complete plant initialization',
    input: { support: b, station: s }, inputHash: hash(JSON.stringify({ support: b, station: s })), sourceHash: hash(await Bun.file(import.meta.path).text()),
    stationSourceHash: hash(await Bun.file(new URL('./reference-design-station.ts', import.meta.url)).text()),
    cycleInputHash: cycle.inputSha256, cycleCalculationHash: cycle.calculationSha256, dependencies: cycle.dependencies, checks, cases,
    sourceBlocked: { positiveLoadSteadyExists: false, reason: 'No selected external heat receiver; finite stores accumulate retained heat, not a fixed-temperature source' },
    liveModelInstalled: false }
}

if (import.meta.main) {
  const [owner, station, cycle, python, ...extra] = Bun.argv.slice(2)
  if (!owner || !station || !cycle || !python || extra.length) throw Error('Usage: reference-design-support-network.ts support.md station.md cycle.md python')
  console.log(JSON.stringify(await runSupport(owner, station, cycle, python), null, 2))
}

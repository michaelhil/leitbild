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
  schema.parse(b)
  if (!Number.isFinite(bypass) || bypass < 0 || bypass > 1 || !Number.isFinite(site_C) || !Number.isFinite(swInletRise_K)) throw Error('Invalid support boundary')
  if (!branches.length || new Set(branches.map(v => v.id)).size !== branches.length || branches.some(v => !v.id || ![v.heat_MW, v.reference_kg_s, v.conductance_MW_K].every(Number.isFinite) || v.heat_MW < 0 || v.reference_kg_s <= 0 || v.conductance_MW_K <= 0) || (blocked && !branches.some(v => v.id === blocked))) throw Error('Invalid selected jacket branch')
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
  const rhrOutlet = rhrFlow > 0 && inlet !== null ? inlet + b.rhrLoad_MW / (rhrFlow * cpMW) : null
  const pressureResidual_MPa = head - (localK + commonK) * m ** 2
  const flowResidual_kg_s = m - details.reduce((a, v) => a + v.flow_kg_s, 0) - rhrFlow
  const energyResidual_MW = returned === null || supply === null ? null : m * cpMW * (returned - supply) - totalHeat
  const branchMixResidual_MW = feasible ? cpMW * (details.reduce((a, v) => a + v.flow_kg_s * v.outlet_C!, 0) + rhrFlow * (rhrOutlet ?? 0) - m * returned!) : null
  const supplyMixResidual_MW = feasible ? cpMW * (hxFlow * cooled + bypassFlow * returned! - m * supply!) : null
  if (![pressureResidual_MPa, flowResidual_kg_s, totalHeat, m, head].every(Number.isFinite) || Math.abs(pressureResidual_MPa) > 1e-10 || Math.abs(flowResidual_kg_s) > 1e-9 || [energyResidual_MW, branchMixResidual_MW, supplyMixResidual_MW].some(v => v !== null && (!Number.isFinite(v) || Math.abs(v) > 1e-9))) throw Error('Support balance did not close')
  return { bypass, feasible, reason: feasible ? null : blocked ? 'Heat-producing jacket has no throughflow; no selected ambient sink' : 'No cooler throughflow',
    flow_kg_s: m, head_MPa: head, localDrop_MPa: localK * m * m, commonDrop_MPa: commonK * m * m,
    hxFlow_kg_s: hxFlow, bypassFlow_kg_s: bypassFlow, rhrFlow_kg_s: rhrFlow, rhrOutlet_C: rhrOutlet, pump,
    heat_MW: totalHeat, temperatures_C: { supply, loadInlet: inlet, return: returned, coolerOutlet: feasible ? cooled : null, wall: feasible ? wall : null, swOutlet: feasible ? swOutlet : null }, branches: details,
    pressureResidual_MPa, flowResidual_kg_s, energyResidual_MW, branchMixResidual_MW, supplyMixResidual_MW }
}

/** Independent IF97 caloric check at the selected hydraulic sizing solution.
 * Fixed 0.5 MPa property datum; not an EOS/expansion-vessel dynamic initialization. */
const thermalPropertyCheck = String.raw`
import json,sys
import iapws
from iapws import IAPWS97 as W
b=json.load(sys.stdin);rows=[]
def atT(t):
    q=W(P=.5,T=t+273.15)
    if q.region!=1:raise ValueError('Support thermal comparison left liquid region')
    return q
def atH(h):
    q=W(P=.5,h=h)
    if q.region!=1:raise ValueError('Support enthalpy comparison left liquid region')
    return q
for f in b['frames']:
    p=f['point'];Q=p['heat_MW'];m=p['flow_kg_s'];mh=p['hxFlow_kg_s'];G=b['conductance_MW_K']
    sw=atH(atT(f['site_C']).h+f['swPumpHeat_MW']*1000/f['swTotal_kg_s']+Q*1000/b['swExchanger_kg_s'])
    wall=sw.T-273.15+Q/G;cooler=wall+Q/G
    hc=atT(cooler).h;hr=hc+Q*1000/mh;hs=hr-Q*1000/m;hi=hs+p['pump']['fluid_MW']*1000/m
    supply=atH(hs);ret=atH(hr);inlet=atH(hi)
    branches=[dict(id=v['id'],flow_kg_s=v['flow_kg_s'],h_kJ_kg=hi+v['heat_MW']*1000/v['flow_kg_s']) for v in p['branches']]
    rh=p['rhrFlow_kg_s'];rhH=hi+b['rhrLoad_MW']*1000/rh if rh else 0.
    er=(sum(v['flow_kg_s']*v['h_kJ_kg'] for v in branches)+rh*rhH-m*hr)/1000
    sr=(mh*hc+p['bypassFlow_kg_s']*hr-m*hs)/1000
    if max(abs(er),abs(sr))>1e-9:raise ValueError('Independent enthalpy mixing failed')
    rows.append(dict(case=f['name'],supply_C=supply.T-273.15,return_C=ret.T-273.15,loadInlet_C=inlet.T-273.15,
        constantCpSupplyDifference_K=supply.T-273.15-p['temperatures_C']['supply'],branchMixResidual_MW=er,supplyMixResidual_MW=sr,
        branches=[dict(id=v['id'],outlet_C=atH(v['h_kJ_kg']).T-273.15) for v in branches]))
print(json.dumps(dict(iapws=iapws.__version__,scope='IF97 enthalpy check at fixed hydraulic sizing flows and bypass, not whole-loop dynamic initialization',rows=rows),allow_nan=False))
`

export function selectSupportPoint(b: Basis, s: Station, branches: Branch[], site_C: number, swInletRise_K: number, rhr = false) {
  const point = (x: number) => supportPoint(b, s, branches, x, site_C, swInletRise_K, rhr)
  const coldest = point(0), target = s.CCW.supply_C
  if (coldest.temperatures_C.supply! > target) return { targetAchievable: false, controller: 'full cooling saturated', point: coldest }
  const position = bisect(x => x === 1 ? Infinity : point(x).temperatures_C.supply! - target, 0, 1)
  return { targetAchievable: true, controller: 'zero-error integral equals achieved bypass position', point: point(position) }
}

/** Design-time sizing, not an instruction to resize installed jackets when duty changes. */
export function sizeSupportJackets(b: Basis, s: Station, cycle: { powers_MW: Record<string, number> }) {
  const old = calculateStation(s, cycle), P = cycle.powers_MW
  const reference = (id: string, heat_MW: number, conductance_MW_K: number): Branch => ({ id, heat_MW, conductance_MW_K,
    reference_kg_s: Math.max(b.minimumBranch_kg_s, heat_MW * 1e6 / s.waterCp_J_kgK / b.jacketDesignRise_K) })
  const rc = (P.RCP_electric! - P.RCP_fluid!) / 4, fw = (P.feed_pump_electric! - P.feed_pump_fluid!) / 2
  const G = b.jacket_MW_K
  const A = [reference('RCP.A1', rc, G.rcp), reference('RCP.B1', rc, G.rcp), reference('FW.P1', fw, G.feed),
    reference('COND.P', P.condensate_pump_electric! - P.condensate_pump_fluid!, G.small), reference('CHARGE.P', 0, G.small)]
  const B = [reference('RCP.A2', rc, G.rcp), reference('RCP.B2', rc, G.rcp), reference('FW.P2', fw, G.feed), reference('TG.OIL', old.powers_MW.oilLoss, G.oil)]
  return { A, B }
}

export async function runSupport(owner: string, stationOwner: string, cycleOwner: string, python: string) {
  const b = parseSupportBasis(await Bun.file(owner).text()), s = parseStationBasis(await Bun.file(stationOwner).text())
  const cycle = await runCycle(await Bun.file(cycleOwner).text(), python), old = calculateStation(s, cycle)
  const { A, B } = sizeSupportJackets(b, s, cycle)
  const swRise = (train: 'A' | 'B') => old.pumps[train === 'A' ? 'SWA' : 'SWB'].fluid_MW * 1e6 / (s.waterCp_J_kgK * s.SW[train === 'A' ? 'flowA_kg_s' : 'flowB_kg_s'])
  const normalA = selectSupportPoint(b, s, A, s.siteWater_C, swRise('A')), normalB = selectSupportPoint(b, s, B, s.siteWater_C, swRise('B'))
  const stationWithResolvedBranches = calculateStation(s, cycle, {
    A: { flow_kg_s: normalA.point.flow_kg_s, head_MPa: normalA.point.head_MPa },
    B: { flow_kg_s: normalB.point.flow_kg_s, head_MPa: normalB.point.head_MPa },
  })
  const cases = { normalA, normalB, warmA: selectSupportPoint(b, s, A, 35, swRise('A')), warmB: selectSupportPoint(b, s, B, 35, swRise('B')),
    rhrDutyA: selectSupportPoint(b, s, A, s.siteWater_C, swRise('A'), true), rhrDutyB: selectSupportPoint(b, s, B, s.siteWater_C, swRise('B'), true),
    blockedOil: supportPoint(b, s, B, normalB.point.bypass, s.siteWater_C, swRise('B'), false, 'TG.OIL') }
  const checks = { nominalTargets: normalA.targetAchievable && normalB.targetAchievable,
    warmerSourceCannotReachTarget: !cases.warmA.targetAchievable && !cases.warmB.targetAchievable,
    noBlockedJacketSteady: !cases.blockedOil.feasible,
    actualPumpCompetition: cases.rhrDutyB.point.rhrFlow_kg_s < b.rhrReference_kg_s,
    preserveUnequalDuties: normalA.point.flow_kg_s !== normalB.point.flow_kg_s }
  const propertyInput = { conductance_MW_K: b.exchangerSide_MW_K, swExchanger_kg_s: b.serviceExchangerFlow_kg_s, rhrLoad_MW: b.rhrLoad_MW,
    frames: Object.entries(cases).filter(([name]) => name !== 'blockedOil').map(([name, value]) => ({ name, point: 'point' in value ? value.point : value,
      site_C: name.startsWith('warm') ? 35 : s.siteWater_C, swPumpHeat_MW: name.endsWith('A') ? old.pumps.SWA.fluid_MW : old.pumps.SWB.fluid_MW,
      swTotal_kg_s: name.endsWith('A') ? s.SW.flowA_kg_s : s.SW.flowB_kg_s })) }
  const child = Bun.spawn([python, '-c', thermalPropertyCheck], { stdin: new Blob([JSON.stringify(propertyInput)]), stdout: 'pipe', stderr: 'pipe' })
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exit) throw Error(error)
  const hash = (t: string) => createHash('sha256').update(t).digest('hex')
  return { scope: 'Offline constant-property support sizing on retained station/cycle duties, not new-core or complete plant initialization',
    input: { support: b, station: s }, inputHash: hash(JSON.stringify({ support: b, station: s })), sourceHash: hash(await Bun.file(import.meta.path).text()),
    stationSourceHash: hash(await Bun.file(new URL('./reference-design-station.ts', import.meta.url)).text()),
    cycleInputHash: cycle.inputSha256, cycleCalculationHash: cycle.calculationSha256, dependencies: cycle.dependencies, checks, cases, propertyCheck: JSON.parse(output), stationWithResolvedBranches,
    sourceBlocked: { positiveLoadSteadyExists: false, reason: 'No selected external heat receiver; finite stores accumulate retained heat, not a fixed-temperature source' },
    liveModelInstalled: false }
}

if (import.meta.main) {
  const [owner, station, cycle, python, ...extra] = Bun.argv.slice(2)
  if (!owner || !station || !cycle || !python || extra.length) throw Error('Usage: reference-design-support-network.ts support.md station.md cycle.md python')
  console.log(JSON.stringify(await runSupport(owner, station, cycle, python), null, 2))
}

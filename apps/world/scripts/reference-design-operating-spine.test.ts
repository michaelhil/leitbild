import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { carveOperatingPrimary, compileOperatingSurgeHydraulics, prepareOperatingSpine } from './reference-design-operating-spine'
import { operatingCirculationCycles } from './reference-design-operating-hydraulics'
import { compileOperatingPzr } from './reference-design-operating-pzr'
import { routeElevation } from './reference-design-surge-route'

// Test-only stock amounts: structural conservation independently of IF97.
function fixture() {
  const names = ['CORE.NE.1', 'CORE.NE.2', 'CORE.NW.1', 'CORE.NW.2', 'CORE.SW.1', 'CORE.SW.2', 'CORE.SE.1', 'CORE.SE.2',
    'DOWN', 'LOWER', 'UPPER', 'HOT.A', 'SG.A.PRIMARY', 'PUMP.A1', 'PUMP.A2', 'COLD.A', 'RETURN.A',
    'HOT.B', 'SG.B.PRIMARY', 'PUMP.B1', 'PUMP.B2', 'COLD.B', 'RETURN.B', 'HOUSING.MAIN', 'HOUSING.NECK', 'SURGE']
  const regions = names.map((id, i) => ({ id, volume_m3: id === 'HOT.A' ? 15 : 1 + i / 10,
    mass_kg: 100 + i, internalEnergy_J: 10000 + i, massPAtEnergy_kg_Pa: .001 + i / 10000,
    massEnergyAtPressure_kg_J: -.0001, absorberTracer_kgEq: .1 + i / 1000,
    energyP_J_Pa: 2 + i, energyT_J_K: 300 + i, liquidMass_kg: 100 + i, steamMass_kg: 0,
    airMass_kg: 0, nitrogenMass_kg: 0, mainFlowArea_m2: 1, elevation_m: 2.5 }))
  const edges: { id: string, from: number, to: number }[] = []
  const add = (a: string, b: string) => edges.push({ id: a + '->' + b, from: names.indexOf(a), to: names.indexOf(b) })
  add('DOWN', 'LOWER')
  for (const sector of ['NE', 'NW', 'SW', 'SE']) { add('LOWER', `CORE.${sector}.1`); add(`CORE.${sector}.1`, `CORE.${sector}.2`); add(`CORE.${sector}.2`, 'UPPER') }
  for (const side of ['A', 'B']) {
    add('UPPER', `HOT.${side}`); add(`HOT.${side}`, `SG.${side}.PRIMARY`)
    for (const p of [1, 2]) { add(`SG.${side}.PRIMARY`, `PUMP.${side}${p}`); add(`PUMP.${side}${p}`, `COLD.${side}`) }
    add(`COLD.${side}`, `RETURN.${side}`); add(`RETURN.${side}`, 'DOWN')
  }
  add('UPPER', 'HOUSING.MAIN'); add('HOUSING.MAIN', 'HOUSING.NECK'); add('HOT.A', 'SURGE')
  const area = Math.PI / 4, stub = (15 - area) / 2
  const partition = { sourceOwner: 'HOT.A', totalVolume_m3: 15, area_m2: area,
    parts: [{ id: 'HOT.A.UPSTREAM', volume_m3: stub, length_m: stub / area },
      { id: 'HOT.A.JUNCTION', volume_m3: area, length_m: 1 }, { id: 'HOT.A.DOWNSTREAM', volume_m3: stub, length_m: stub / area }] }
  return { regions, edges, partition }
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)

test('fixed HOT.A carve conserves all extensive stores and removes SURGE once without mutation', () => {
  const f = fixture(), before = structuredClone(f), c = carveOperatingPrimary(f.regions, f.edges, f.partition)
  expect(c.regions).toHaveLength(27); expect(c.edges).toHaveLength(33); expect(c.tree.cycles).toHaveLength(7)
  expect(c.regions.some(r => r.id === 'SURGE' || r.id === 'HOT.A')).toBe(false)
  for (const key of ['volume_m3', 'mass_kg', 'internalEnergy_J', 'massPAtEnergy_kg_Pa', 'absorberTracer_kgEq', 'energyP_J_Pa', 'energyT_J_K', 'liquidMass_kg'] as const)
    expect(sum(c.regions.map(r => r[key])) + c.surgeStock[key]).toBeCloseTo(sum(f.regions.map(r => r[key])), 8)
  for (const p of c.regions.filter(r => r.id.startsWith('HOT.A.'))) expect(p.massEnergyAtPressure_kg_J).toBe(f.regions[c.hot]!.massEnergyAtPressure_kg_J)
  expect(c.regions[c.junction]!.volume_m3).toBe(Math.PI / 4)
  expect(f).toEqual(before)
  const cycles = operatingCirculationCycles({ regions: f.regions, edges: f.edges })
  for (const column of cycles.columns) {
    const rebased = c.edges.map(() => 0), B = c.regions.map(() => 0)
    for (const [e, targets] of c.edgeMap.entries()) for (const t of targets) rebased[t] = column[e]!
    for (const [e, w] of rebased.entries()) { B[c.edges[e]!.from]! -= w; B[c.edges[e]!.to]! += w }
    expect(B).toEqual(c.regions.map(() => 0))
  }
})

test('carve refuses altered partition, hidden owners and malformed incidence', () => {
  const f = fixture()
  const bad = structuredClone(f.partition); bad.parts[1]!.volume_m3 *= 2
  expect(() => carveOperatingPrimary(f.regions, f.edges, bad)).toThrow('partition')
  const changed = structuredClone(f.regions); changed[11]!.internalEnergy_J = NaN
  expect(() => carveOperatingPrimary(changed, f.edges, f.partition)).toThrow('stock')
  const other = structuredClone(f.edges); other[31]!.from = 10
  expect(() => carveOperatingPrimary(f.regions, other, f.partition)).toThrow('port')
  const outside = structuredClone(f.edges); outside[0]!.from = -1
  expect(() => carveOperatingPrimary(f.regions, outside, f.partition)).toThrow('incidence')
})

test('actual five-piece surge splits at8m with disjoint inertia, head, elbow and first-moment geometry', () => {
  const record = (name: string, value: unknown) => '```' + name + '\n' + JSON.stringify(value) + '\n```'
  const pzr = compileOperatingPzr(record('reference-operating-pzr', {
    commonPressure_Pa: 15e6, liquidTemperature_K: 600, vaporTemperature_K: 630, phaseBoundaryHeight_m: 6,
    bands_m: [0, 1, 3, 6, 9, 12], interfacialLength_m: .003, solidRoughness_m: .000045, absorberMassFraction: .001 }), record('reference-surge-route', {
      source: 'LD01.HOT.A', receiver: 'LD01.PZR', sourceElevation_m: 2.5, receiverElevation_m: 6.5,
      developedLength_m: 16, firstStraight_m: 6, bendRadius_m: .45, internalDiameter_m: .3, wallThickness_m: .025,
      steelDensity_kg_m3: 7920, roughness_m: .0000015, entryLoss: .5, elbowLoss: .2, exitLoss: 1 }),
    { id: 'HOT.A', volume_m3: 15, mainFlowArea_m2: Math.PI / 4, elevation_m: 2.5 })
  const h = compileOperatingSurgeHydraulics(pzr), A = Math.PI * .3 ** 2 / 4
  expect(h.halves.map(p => p.length_m)).toEqual([8, 8])
  expect(h.halves.map(p => p.elevationChange_m)).toEqual([0, 4])
  expect(h.halves.map(p => p.elbowLoss)).toEqual([.2, .2])
  expect(h.halves.flatMap(p => p.pieces)).toHaveLength(6)
  expect(sum(h.halves.map(p => p.volume_m3))).toBeCloseTo(16 * A, 14)
  expect(h.halves[0]!.pieces.at(-1)!.physical_piece_id).toBe('SURGE.PHYSICAL.2')
  expect(h.halves[1]!.pieces[0]!.physical_piece_id).toBe('SURGE.PHYSICAL.2')
  expect(h.halves[0]!.pieces.at(-1)!.end_m).toBe(h.halves[1]!.pieces[0]!.start_m)
  expect(h.momentumPlane).toEqual({ distance_m: 8, elevation_m: 2.5 })
  expect(h.inventoryMeanElevation_m).toBeGreaterThan(h.momentumPlane.elevation_m)
  for (const half of h.halves) {
    expect(half.geometricInertance_per_m).toBeCloseTo(8 / A, 12)
    expect(half.roughness_m).toBe(.0000015); expect(half.additionalThermalPower).toBe(false)
    // Independent bounded midpoint quadrature of actual z(s), not the compiler's primitive.
    const n = 2000, ds = half.length_m / n
    let integral = 0
    for (let i = 0; i < n; i++) integral += routeElevation(pzr.surge.route, half.start_m + (i + .5) * ds) * ds
    expect(Math.abs(integral / half.length_m - half.meanElevation_m)).toBeLessThan(2e-7)
  }
  expect(h.endpointLoss.hotEntrance).toBe(0); expect(h.endpointLoss.pzrReceipt).toBe(0)
  expect(h.endpointLoss.pzrWithdrawalCdA_m2).toBeCloseTo(A / Math.sqrt(1.5), 14)
  expect(h.junctionFirstMoment.lateralInertance_per_m).toBeCloseTo(Math.sqrt(Math.PI / 4) / (2 * A), 13)
  expect(h.junctionFirstMoment.status).toBe('PROJECTION_CANDIDATE')
  expect(h.junctionFirstMoment.scope).toContain('expansion-tree')
  const cut = structuredClone(pzr); cut.surge.pieces[1]!.start_m = 7; cut.surge.pieces[1]!.end_m = 9
  expect(() => compileOperatingSurgeHydraulics(cut)).toThrow('split elbow')
})

const wiki = process.env.LD01_WIKI_ROOT, if97 = process.env.LD01_IF97_DIRECTORY
if (!!wiki !== !!if97) throw Error('Supply both actual wiki and pinned IF97 directory')
test.skipIf(!wiki || !if97)('actual single hot packet rebases every recipient, finite store and hydraulic cycle; native consumes it', async () => {
  const p = await prepareOperatingSpine(wiki!, if97!)
  expect(p.thermal.water).toHaveLength(27); expect(p.edges).toHaveLength(33)
  expect(p.hot.fluid.regions.map(r => r.id)).toEqual(p.thermal.water.map(r => r.id))
  expect(p.source_water).toHaveLength(24); expect(p.water_flow_area_m2).toHaveLength(27); expect(p.water_boron_amount_kg_eq).toHaveLength(27)
  expect(p.thermal.fuel_bands).toHaveLength(386); expect(p.thermal.helium).toHaveLength(193)
  expect(p.thermal.core_contacts).toHaveLength(448); expect(p.thermal.sg_segments).toHaveLength(8)
  const h = p.thermal.water.filter(r => r.id.startsWith('HOT.A.'))
  expect(sum(h.map(r => r.volume_m3))).toBe(15); expect(h[1]!.volume_m3).toBe(Math.PI / 4)
  expect(sum(h.map(r => r.mass_kg))).toBeCloseTo(15 * 679.3368894359069, 8)
  expect(p.hot.fluid.primary_mass_kg).toBeCloseTo(sum(p.thermal.water.map(r => r.mass_kg)), 8)
  expect(p.hot.fluid.primary_energy_j).toBeCloseTo(sum(p.thermal.water.map(r => r.energy_j)), 3)
  expect(sum(p.water_boron_amount_kg_eq)).toBeCloseTo(p.hot.fluid.primary_mass_kg / 1000, 9)
  expect(p.external_ports.surge_stock.volume_m3).toBeCloseTo(p.pzr.surge.route.liquidVolume_m3, 13)
  expect(p.external_ports.surge_stock.absorberTracer_kgEq).toBeCloseTo(p.external_ports.surge_stock.mass_kg / 1000, 12)
  expect(p.thermal.water[p.external_ports.primary_to_surge.primary_water]!.id).toBe('HOT.A.JUNCTION')
  expect(p.hydraulics.sections).toHaveLength(21); expect(p.hydraulics.cycles.columns).toHaveLength(7)
  expect(p.hydraulics.surge.halves).toHaveLength(2)
  expect(p.hydraulics.surge.halves.map(h => h.elevationChange_m)).toEqual([0, 4])
  expect(p.pzr.faces.every(f => f.distance_m > 0 && f.normal.length === 2)).toBe(true)
  expect(p.hydraulics.coveredEdges).toHaveLength(31); expect(p.hydraulics.unclosedTreeEdges).toHaveLength(2)
  expect(p.hydraulics.mainInertance.aa).toBeCloseTo(70.629211610045, 10)
  expect(p.hydraulics.mainInertance.ab).toBeCloseTo(2.654786439092273, 12)
  expect(p.hydraulics.mainInertance.bb).toBeCloseTo(70.629211610045, 10)
  expect(sum(p.hydraulics.sections.filter(s => s.id.startsWith('HOT.A.')).map(s => s.parameters.form_loss))).toBeCloseTo(.49504493, 14)
  for (const column of p.hydraulics.cycles.columns) {
    const B = p.thermal.water.map(() => 0)
    for (const [e, q] of column.entries()) { B[p.edges[e]!.from]! -= q; B[p.edges[e]!.to]! += q }
    expect(B).toEqual(p.thermal.water.map(() => 0))
  }
  for (const c of [...p.thermal.core_contacts, ...p.thermal.passive_contacts]) expect(p.thermal.water[c.water]).toBeDefined()
  for (const c of p.thermal.sg_segments) expect(p.thermal.water[c.primary]!.id).toBe(`SG.${c.id.split('.')[1]}.PRIMARY`)
  for (const [i, w] of p.source_water.entries()) expect(p.thermal.water[w]!.id).toBe(`CORE.${['NE', 'NW', 'SW', 'SE'][Math.floor(i / 6)]}.${i % 6 < 3 ? 1 : 2}`)
  // The gas energy datum is actual ideal-He U=3/2 nRT, never solid's273.15K datum.
  for (const he of p.thermal.helium) expect(he.energy_j).toBeCloseTo(1.5 * he.nr_j_k * he.temperature_k, 7)
  expect(p.preparation.direct_source_projection.donorBranchConsistent).toBe(true)
  expect(p.preparation.direct_source_projection.maxConstraintDefect_kg_s).toBeLessThan(1e-7)
  const native = process.env.LD01_OPERATING_HOT_SPINE_TEST
  if (native) {
    const directory = await mkdtemp(join(tmpdir(), 'ld01-hot-spine-'))
    try {
      const path = join(directory, 'packet.json'); await Bun.write(path, JSON.stringify(p))
      const child = Bun.spawn([native, '--ignored', '--nocapture'], {
        env: { ...process.env, LD01_OPERATING_HOT_SPINE_PACKET: path }, stdout: 'pipe', stderr: 'pipe' })
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw Error(error + output)
      expect(output).toContain('1 passed'); console.log(error.trim())
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30000)

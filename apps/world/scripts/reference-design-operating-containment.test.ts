import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'
import { compileOperatingContainment, type ContainmentPages } from './reference-design-operating-containment'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence = (name: string, body: unknown) => '```' + name + '\n' + JSON.stringify(body) + '\n```\n'
const atmosphere = { gasVolume_m3: 60000, modeledEnclosure_m3: 61229.654930, prhrEnvelope_m3: 29.654930, initialTemperature_C: 25, initialTotalPressure_kPa: 101.325,
  initialVapor: 'saturated', airGasConstant_J_kgK: 287, airCv_J_kgK: 718, vaporGasConstant_J_kgK: 461.5, vaporCv_J_kgK: 1410, vaporCp_J_kgK: 1871.5,
  referenceTemperature_K: 298.15, vaporReference: 'saturated-vapor-at-reference', nitrogenGasConstant_J_kgK: 296.8, nitrogenCv_J_kgK: 742, originElevation_m: 20,
  maxTotalPressure_MPa: 0.5, maxGasTemperature_C: 160 }
const shell = { totalArea_m2: 18000, totalCapacity_MJ_K: 2500, initialTemperature_C: 25, dryContactTotal_MW_K: 0.20, condensationVelocity_m_s: 0.01,
  upper: { area_m2: 12000, formationElevation_m: 20, receiver: 'GUTTER' }, lower: { area_m2: 4981.55, formationElevation_m: 6, receiver: 'FLOOR' },
  remainderArea_m2: 16981.55, remainderCapacity_J_K: 2358548611.111111, localArea_m2: 1018.45, localCapacity_J_K: 141451388.888889,
  localCapacityPerArea_J_m2K: 138888.888888889 }
const floorPatch = (id: string, bays: string[], area_m2: number, elevation_m: number) => ({ id, bays, kind: 'floor', area_m2, elevation_m })
const wall = (id: string, bays: string[], area_m2: number, elevation_m: number, rectangles_m: number[][]) =>
  ({ id, bays, kind: 'wall', area_m2, elevation_m, rectangles_m })
const localHosts = { floors_m: { WELL: 4, CANAL: 3.5, POOL: -0.75 }, top_m: 14, patches: [
  floorPatch('WELL.FLOOR', ['WELL'], 8.25, 4), wall('WELL.WEST', ['WELL'], 50, 9, [[5, 4, 14]]), wall('WELL.NORTH', ['WELL'], 50, 9, [[5, 4, 14]]),
  wall('WELL.SOUTH', ['WELL'], 50, 9, [[5, 4, 14]]), wall('WELL.EAST', ['WELL'], 40, 9, [[4, 4, 14]]), floorPatch('CANAL.FLOOR', ['CANAL'], 6, 3.5),
  wall('CANAL.NORTH', ['CANAL'], 63, 8.75, [[6, 3.5, 14]]), wall('CANAL.SOUTH', ['CANAL'], 63, 8.75, [[6, 3.5, 14]]),
  wall('CANAL.SILL', ['CANAL'], 0.5, 3.75, [[1, 3.5, 4]]), floorPatch('POOL.FLOOR', ['POOL'], 100, -0.75),
  wall('POOL.EAST', ['POOL'], 147.5, 6.625, [[10, -0.75, 14]]), wall('POOL.NORTH', ['POOL'], 147.5, 6.625, [[10, -0.75, 14]]),
  wall('POOL.SOUTH', ['POOL'], 147.5, 6.625, [[10, -0.75, 14]]), wall('POOL.WEST', ['POOL'], 137, 6.46213503650, [[9, -0.75, 14], [1, -0.75, 3.5]]),
  wall('WELL-CANAL', ['WELL', 'CANAL'], 4, 9, [[0.4, 4, 14]]), wall('CANAL-POOL', ['CANAL', 'POOL'], 4.2, 8.75, [[0.4, 3.5, 14]])] }
const pools = {
  wst: { water_m3: 1200, initialTemperature_C: 25, tracer_ppm: 2000, width_m: 32, length_m: 6.25, area_m2: 200, floor_m: 8, initialSurface_m: 14.148275,
    hardwareBottom_m: 10.72, hardwareTop_m: 13.28, exposureLoss_m3: 173.654930, spillRim_m: 15.5, spillWidth_m: 4, spillReceiver: 'FLOOR' },
  gutter: { area_m2: 20, floor_m: 16, returnChutes: 2, chuteWidth_m: 0.25, chuteCrest_m: 16.02, chuteReceiver: 'WST', emergencyCrest_m: 16.5,
    emergencyWidth_m: 1, emergencyReceiver: 'FLOOR', crestStorage_m3: 10 },
  sump: { area_m2: 200, floor_m: -2, rim_m: 4, rimWidth_m: 4, rimReceiver: 'FLOOR' },
  floor: { area_m2: 800, deck_m: 4, drainMouth_m: 4.1, retainedLayer_m3: 80, drains: 2, drainReference_kg_s: 50, drainReferenceHead_kPa: 5,
    drainReferenceTemperature_K: 298.15, drainReferencePressure_Pa: 101325 },
  crestCoefficient: 1.7, surfaceTransferVelocity_m_s: 0.001 }
const droplets = { origin_m: 20, diameter_mm: 1, sensitivityDiameters_mm: [0.5, 2], dragStokes: 24, dragCorrection: 0.15, dragExponent: 0.687,
  dragReynoldsLimit: 1000, newtonDrag: 0.44, receiver: 'FLOOR', airViscosity: { reference_Pa_s: 1.846e-5, referenceTemperature_K: 300, exponent: 0.7 },
  nitrogenViscosity: { reference_Pa_s: 1.76e-5, referenceTemperature_K: 300, exponent: 0.7 }, vaporViscosity: 'native-saturated-vapor' }
const exterior = { tank_m3: 1500, tankTemperature_C: 25, tankArea_m2: 250, tankBottom_m: 30, filmDatum_m: 0, initialHead_m: 36, fullOpenFeed_kg_s: 25,
  feedReferenceHead_m: 36, valveTravel_s: 5, valveActuator: 'ACT.B', valveRoom: 'ROOM.B', holdPower_W: 20, closingPower_W: 1000, springStock_J: 2500,
  filmReferenceMass_kg: 20000, filmConductance_MW_K: 1.5, runoffResidence_s: 800, dryConductance_MW_K: 0.10, ambientTemperature_C: 25, ambientPressure_kPa: 101.325 }
const prhr = { tubes: { count: 300, id_m: 0.05, od_m: 0.06, straightLeg_m: 5, bendRadius_m: 0.25, pitch_m: 0.1, top_m: 12.96, bottom_m: 11.04, bendLoss_K: 0.2,
  entryExitLoss_K: 1.5 }, header: { id_m: 0.6, od_m: 0.64, length_m: 30 }, hotConnector: { id_m: 0.5, od_m: 0.54, length_m: 13.5 } }

const blocks = { atmosphere, shell, localHosts, pools, droplets, exterior }
type Block = keyof typeof blocks
const fences: Record<Block, string> = { atmosphere: 'ld01-cnv-atmosphere', shell: 'ld01-cnv-shell', localHosts: 'ld01-cnv-local-hosts',
  pools: 'ld01-cnv-pools', droplets: 'ld01-cnv-droplets', exterior: 'ld01-pcc-exterior' }
function pages(over: Partial<Record<Block, unknown>> = {}): ContainmentPages {
  const strict = (Object.keys(fences) as Block[]).map(k => fence(fences[k], over[k] ?? blocks[k])).join('\n')
  const reservoir = '## Containment gas and shell\n\nProse.\n\n## Compact operating allocation (15 October 2026)\n\n### Compartment count\n\nOne.\n\n### Strict blocks\n\n'
    + strict + '\n### Open items\n\nNone.\n'
  const exchanger = '## Physical bank and joint capacity decision\n\n### Geometry, finite owners and actual height\n\n' + fence('reference-prhr-geometry', prhr)
  return { atmosphere: reservoir, shell: reservoir, localHosts: reservoir, pools: reservoir, droplets: reservoir, exterior: reservoir, prhr: exchanger }
}

/** Every object key path in a block, nested objects and array elements included. */
const keyPaths = (v: unknown, prefix: (string | number)[] = []): (string | number)[][] =>
  Array.isArray(v) ? v.flatMap((x, i) => keyPaths(x, [...prefix, i]))
    : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [[...prefix, k], ...keyPaths(x, [...prefix, k])]) : []
function edit<T>(block: T, path: (string | number)[], change: (parent: Record<string | number, unknown>, key: string | number) => void): T {
  const copy = structuredClone(block) as Record<string | number, unknown>
  const parent = path.slice(0, -1).reduce<Record<string | number, unknown>>((o, k) => o[k] as Record<string | number, unknown>, copy)
  change(parent, path.at(-1)!)
  return copy as T
}
const without = <T>(block: T, path: (string | number)[]) => edit(block, path, (o, k) => { delete o[k] })
const replaced = <T>(block: T, path: (string | number)[], value: unknown) => edit(block, path, (o, k) => { o[k] = value })

test('compiles the containment owners into the SI packet and counts 38 + 23 coordinates', () => {
  const c = compileOperatingContainment(pages())
  expect(c.census).toMatchObject({ differential: 38, algebraic: 23, total: 61, bayTemplate: { perBay: { differential: 3, algebraic: 4 }, bays: 3, total: 21 } })
  expect(c.census.owners.map(o => o.owner).slice(0, 2)).toEqual(['CNV', 'SHELL.REMAINDER'])
  expect(c.census.owners.at(-1)).toEqual({ owner: 'PCC.FILM', differential: ['M', 'H'], algebraic: ['T', 'm_evap'] })
  expect(c.atmosphere).toMatchObject({ initialPressure_Pa: 101325, initialTemperature_K: 298.15, maxPressure_Pa: 500000, maxTemperature_K: 433.15,
    enclosure_m3: 61229.65493, origin_m: 20 })
  const [wst, ...empty] = c.pools
  expect(wst!.hardware!.firstMoment_m4).toBeCloseTo(355.85916, 9)
  expect(wst).toMatchObject({ id: 'WST', initialTracer_kg_kg: 0.002, initialSurface_m: 14.148275, initialTemperature_K: 298.15,
    hardware: { volume_m3: 29.65493, bottom_m: 10.72, top_m: 13.28 } })
  expect(empty.map(p => [p.id, p.area_m2, p.floor_m, p.initialWater_m3, p.initialTemperature_K, p.initialSurface_m, p.hardware])).toEqual([
    ['GUTTER', 20, 16, 0, null, 16, null], ['FLOOR', 800, 4, 0, null, 4, null], ['SUMP', 200, -2, 0, null, -2, null]])
  expect(c.shell.remainder.capacity_J_K).toBe(2358548611.111111)
  expect(c.shell.remainder.catchments.map(x => [x.id, x.area_m2, x.elevation_m, x.receiver])).toEqual([['UPPER', 12000, 20, 'GUTTER'], ['LOWER', 4981.55, 6, 'FLOOR']])
  expect(c.shell.dryContactTotal_W_K).toBe(200000)
  expect(c.shell.local).toHaveLength(16)
  expect(c.shell.local.reduce((s, p) => s + p.capacity_J_K, 0)).toBeCloseTo(141451388.888889, 3)
  expect(c.shell.local.find(p => p.id === 'CANAL-POOL')!.bays).toEqual(['CANAL', 'POOL'])
  expect(c.paths.crests.map(x => [x.id, x.from, x.to, x.width_m, x.crest_m])).toEqual([
    ['GUTTER.RETURN.1', 'GUTTER', 'WST', 0.25, 16.02], ['GUTTER.RETURN.2', 'GUTTER', 'WST', 0.25, 16.02], ['GUTTER.SPILL', 'GUTTER', 'FLOOR', 1, 16.5],
    ['WST.SPILL', 'WST', 'FLOOR', 4, 15.5], ['SUMP.RIM', 'SUMP', 'FLOOR', 4, 4]])
  expect(c.paths.drains).toEqual({ from: 'FLOOR', to: 'SUMP', count: 2, face_m: 4.1, reference_kg_s: 50, referenceHead_Pa: 5000,
    referenceTemperature_K: 298.15, referencePressure_Pa: 101325 })
  expect(c.droplets).toMatchObject({ diameter_m: 0.001, sensitivityDiameters_m: [0.0005, 0.002], receiver: 'FLOOR',
    airViscosity: { reference_Pa_s: 1.846e-5, referenceTemperature_K: 300, exponent: 0.7 }, vaporViscosity: 'native-saturated-vapor' })
  expect(c.paths.crests.map(x => x.law)).toEqual(['backwater', 'backwater', 'backwater', 'backwater', 'receiving-surface'])
  expect(c.shell.local.find(p => p.id === 'POOL.WEST')!.rectangles_m).toEqual([[9, -0.75, 14], [1, -0.75, 3.5]])
  expect(c.exterior).toMatchObject({ feedReferenceHead_m: 36, dryConductance_W_K: 100000, film: { referenceMass_kg: 20000, conductance_W_K: 1500000 },
    valve: { actuator: 'ACT.B', room: 'ROOM.B' }, ambient: { temperature_K: 298.15, pressure_Pa: 101325 } })
})

describe('refuses a missing value: every key of every block', () => {
  for (const block of Object.keys(blocks) as Block[])
    for (const path of keyPaths(blocks[block]))
      test(`${block}.${path.join('.')}`, () => {
        expect(() => compileOperatingContainment(pages({ [block]: without(blocks[block], path) }))).toThrow(ZodError)
      })
})

test('refuses an extra key at the top of every block and inside nested objects', () => {
  for (const block of Object.keys(blocks) as Block[])
    expect(() => compileOperatingContainment(pages({ [block]: { ...blocks[block], extra: 1 } }))).toThrow(ZodError)
  for (const [block, path] of [['shell', ['upper', 'extra']], ['localHosts', ['floors_m', 'EXTRA']], ['localHosts', ['patches', 3, 'extra']],
    ['pools', ['wst', 'extra']], ['pools', ['floor', 'extra']]] as [Block, (string | number)[]][])
    expect(() => compileOperatingContainment(pages({ [block]: replaced(blocks[block], path, 1) }))).toThrow(ZodError)
})

test('refuses wrong literals and a non-bay patch', () => {
  expect(() => compileOperatingContainment(pages({ atmosphere: { ...atmosphere, initialVapor: 'dry' } }))).toThrow(ZodError)
  expect(() => compileOperatingContainment(pages({ exterior: { ...exterior, valveActuator: 'ACT.A' } }))).toThrow(ZodError)
  expect(() => compileOperatingContainment(pages({ shell: replaced(shell, ['upper', 'receiver'], 'FLOOR') }))).toThrow(ZodError)
  expect(() => compileOperatingContainment(pages({ localHosts: replaced(localHosts, ['patches', 0, 'bays'], ['SUMP']) }))).toThrow(ZodError)
})

test('refuses inconsistent values', () => {
  const refuses = (over: Partial<Record<Block, unknown>>, message: RegExp) => expect(() => compileOperatingContainment(pages(over))).toThrow(message)
  refuses({ pools: replaced(pools, ['wst', 'initialSurface_m'], 14.15) }, /initial surface/)
  refuses({ pools: replaced(pools, ['wst', 'exposureLoss_m3'], 173.7) }, /first-exposure loss/)
  refuses({ pools: replaced(pools, ['wst', 'hardwareTop_m'], 13.3) }, /hardware span/)
  refuses({ pools: replaced(pools, ['gutter', 'crestStorage_m3'], 12) }, /crest storage/)
  refuses({ pools: replaced(pools, ['floor', 'retainedLayer_m3'], 81) }, /retained layer/)
  refuses({ pools: replaced(pools, ['sump', 'rim_m'], 4.5) }, /SUMP rim/)
  refuses({ localHosts: replaced(localHosts, ['patches', 1, 'area_m2'], 51) }, /rectangles give/)
  refuses({ localHosts: replaced(localHosts, ['patches', 0, 'area_m2'], 9) }, /patch areas/)
  refuses({ localHosts: replaced(localHosts, ['patches', 13, 'elevation_m'], 6.5) }, /centroid/)
  refuses({ localHosts: replaced(localHosts, ['patches', 1, 'rectangles_m', 0, 2], 15) }, /outside/)
  expect(() => compileOperatingContainment(pages({ localHosts: replaced(localHosts, ['patches', 1, 'kind'], 'floor') }))).toThrow(ZodError)
  refuses({ localHosts: replaced(localHosts, ['patches', 15, 'id'], 'WELL-POOL') }, /name its bays/)
  refuses({ localHosts: { ...localHosts, patches: localHosts.patches.slice(0, 15) } }, /sixteen/)
  refuses({ atmosphere: { ...atmosphere, modeledEnclosure_m3: 61230 } }, /enclosure/)
  refuses({ atmosphere: { ...atmosphere, prhrEnvelope_m3: 29.7, modeledEnclosure_m3: 61229.7 } }, /PRHR geometry gives/)
  refuses({ atmosphere: { ...atmosphere, vaporCp_J_kgK: 1871 } }, /Vapor cp/)
  refuses({ shell: { ...shell, remainderCapacity_J_K: 2358548612 } }, /capacities/)
  refuses({ shell: replaced(shell, ['lower', 'area_m2'], 4981) }, /catchments/)
  refuses({ exterior: { ...exterior, filmReferenceMass_kg: 19000 } }, /film reference mass/)
  refuses({ exterior: { ...exterior, initialHead_m: 35 } }, /initial head/)
  refuses({ droplets: { ...droplets, sensitivityDiameters_mm: [1.5, 2] } }, /bracket/)
  refuses({ droplets: { ...droplets, origin_m: 18 } }, /origin/)
})

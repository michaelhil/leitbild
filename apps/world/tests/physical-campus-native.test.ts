import { describe, expect, test } from 'bun:test'
import oldSource from '../src/packs/physical-layout/pwr-turbine-island.source.json'
import oldBindings from '../src/packs/physical-layout/pwr-turbine-island.bindings.json'
import { physicalCorrespondenceSchema } from '../src/packs/physical-layout/model.ts'
import { compilePhysicalObjects as originalCompile } from '../src/packs/physical-layout/native/compile-scene.ts'
import { physicalSourceSchema as originalSchema } from '../src/packs/physical-layout/native/source.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from '../src/packs/physical-layout/native/campus/compile-scene.ts'
import { physicalBuildingFootprints } from '../src/packs/physical-layout/native/campus/footprints.ts'
import { physicalSourceSchema, physicalStairFlights, type Element, type Source } from '../src/packs/physical-layout/native/campus/source.ts'

const element = (id: string, change: Partial<Element> = {}): Element => ({ id, label: id, kind: 'context', levelId: 'site', dimensions: { length: 10, width: 8, height: 5 }, pose: { position: [0, 0, 0], yaw: 0 }, disposition: 'installed', ...change })
const source = (elements: Element[]): Source => physicalSourceSchema.parse({ id: 'campus-test', title: 'Native campus profile test', units: 'm', axes: 'Z-up', origin: [0, 0, 0], levels: [{ id: 'admin-ground', label: 'Administration ground floor', elevation: 0, cutHeight: 1.2 }], types: [], elements, evidence: { accuracy: 'illustrative', origin: 'Bounded geometry regression fixture' } })

describe('Retained native campus source and geometry profile', () => {
  test('inherited accepted source produces byte-identical delivery without changing old compiler files', () => {
    const original = originalCompile({ source: originalSchema.parse(oldSource), bindings: oldBindings.map(binding => physicalCorrespondenceSchema.parse(binding)) })
    const expanded = compilePhysicalObjects({ source: physicalSourceSchema.parse(oldSource), bindings: oldBindings })
    expect(expanded).toEqual(original)
  })
  test('building footprint records are cheap, transformed and explicitly closed without mesh output', () => {
    const input = source([element('rect', { kind: 'building', pose: { position: [100, 200, 4], yaw: Math.PI / 2 } }), element('circle', { kind: 'building', footprint: 'ellipse' })])
    input.origin = [10, 20, 0]
    const footprints = physicalBuildingFootprints(input)
    expect(footprints[0]!.ring).toEqual([[90, 180], [90, 190], [82, 190], [82, 180], [90, 180]])
    expect(footprints[0]!.base).toBe(4)
    expect(footprints[1]!.ring).toHaveLength(33)
    expect(footprints[1]!.ring.at(-1)).toEqual(footprints[1]!.ring[0])
    expect(compilePhysicalObjects({ source: input, bindings: [] })).toEqual([])
  })
  test('rejects ambiguous shaped holes, unsupported curved opening hosts and broken building/support relationships', () => {
    const shell = element('shell', { kind: 'wall', dimensions: { length: 20, width: 20, height: 30 }, shape: { kind: 'cylindrical-shell', thickness: 1 } })
    expect(() => source([shell, element('opening', { kind: 'opening', hostId: 'shell' })])).toThrow('Curved hosts')
    expect(() => source([element('bad-building', { buildingId: 'missing' })])).toThrow('Unknown building')
    expect(() => source([element('disc', { kind: 'slab', shape: { kind: 'elliptical-plate' }, holes: [{ x: 1, y: 1, length: 1, width: 1 }] })])).toThrow('do not support rectangular holes')
    expect(() => source([element('bad-shell', { kind: 'wall', shape: { kind: 'cylindrical-shell', thickness: 5 } })])).toThrow('Shell thickness')
    expect(() => source([element('wire', { kind: 'conductor', path: [[0, 0, 10], [10, 0, 9]], supportIds: ['missing'] })])).toThrow('pylon supports')
    expect(() => source([element('road', { kind: 'road', path: [[0, 0, 0], [0, 0, 0]] })])).toThrow('zero-length')
  })
  test('shells keep a true hollow interior and domes and elliptical plates fit authored envelopes', () => {
    const input = source([
      element('shell', { kind: 'wall', dimensions: { length: 20, width: 20, height: 30 }, shape: { kind: 'cylindrical-shell', thickness: 1 } }),
      element('dome', { kind: 'roof', dimensions: { length: 20, width: 20, height: 8 }, pose: { position: [0, 0, 30], yaw: 0 }, shape: { kind: 'dome-shell', thickness: .5 } }),
      element('disc', { kind: 'slab', dimensions: { length: 20, width: 20, height: .5 }, shape: { kind: 'elliptical-plate' } }),
    ])
    const meshes = compilePhysicalObjects({ source: input, bindings: [] }), shell = meshes[0]!
    const radialDistances = Array.from({ length: shell.positions.length / 3 }, (_, index) => Math.hypot(shell.positions[index * 3]! - 10, shell.positions[index * 3 + 1]! - 10))
    expect(Math.min(...radialDistances)).toBeCloseTo(9, 8)
    expect(Math.max(...radialDistances)).toBeCloseTo(10, 8)
    expect(physicalObjectsBounds(meshes)).toEqual({ min: [0, 0, 0], max: [20, 20, 38] })
  })
  test('all new equipment families have distinct finite bounded geometry and no invented subjects', () => {
    const families = ['reactor-vessel', 'steam-generator', 'pressurizer', 'pump', 'reactor-coolant-pump', 'tank', 'heat-exchanger', 'valve', 'diesel-generator', 'cabinet', 'battery', 'transformer', 'breaker', 'disconnector', 'bus-support', 'pylon'] as const
    const input = source([])
    input.types = families.map(kind => ({ id: `type/${kind}`, kind, parameters: { length: 8, width: 6, height: 10 } }))
    input.elements = families.map(kind => element(kind, { kind: 'equipment', typeId: `type/${kind}`, equipmentKind: kind, dimensions: undefined }))
    physicalSourceSchema.parse(input)
    const meshes = compilePhysicalObjects({ source: input, bindings: [] })
    expect(meshes).toHaveLength(families.length)
    expect(new Set(meshes.map(mesh => JSON.stringify(mesh.positions))).size).toBeGreaterThan(11)
    for (const mesh of meshes) {
      expect(mesh.subjectIds).toEqual([])
      expect(mesh.positions.every(Number.isFinite)).toBe(true)
      expect(mesh.normals!.every(Number.isFinite)).toBe(true)
      expect(mesh.positions.length / 9).toBeLessThan(10_000)
    }
  })
  test('conductor routes name physical shared supports separately from operational circuit bindings', () => {
    const input = source([])
    input.types = [{ id: 'tower', kind: 'pylon', parameters: { length: 20, width: 10, height: 45 } }]
    input.elements = [element('pylon-shared', { kind: 'equipment', typeId: 'tower', equipmentKind: 'pylon', dimensions: undefined }),
      element('phase-1', { kind: 'conductor', path: [[0, 0, 20], [100, 0, 18]], supportIds: ['pylon-shared'], terminatesBeyond: true }),
      element('phase-2', { kind: 'conductor', path: [[0, 5, 22], [100, 5, 20]], supportIds: ['pylon-shared'], terminatesBeyond: true })]
    physicalSourceSchema.parse(input)
    const meshes = compilePhysicalObjects({ source: input, bindings: [{ physicalElementId: 'phase-1', elementId: 'circuit-a' }, { physicalElementId: 'phase-2', elementId: 'circuit-b' }] })
    expect(meshes.find(mesh => mesh.id === 'pylon-shared')!.subjectIds).toEqual([])
    expect(meshes.find(mesh => mesh.id === 'phase-1')!.subjectIds).toEqual(['circuit-a'])
    expect(meshes.find(mesh => mesh.id === 'phase-2')!.subjectIds).toEqual(['circuit-b'])
  })
  test('authored stairs serve exact floors with bounded risers, treads, flights and full depth landings', () => {
    const recipe = { landings: [0, 8, 15, 22], maxFlightRise: 2, maxRiser: .175, minTread: .28, flightWidth: 1.4, landingDepth: 1.5 }
    const dimensions = { length: 5, width: 7, height: 22 }, flights = physicalStairFlights(dimensions, recipe)
    for (const floor of recipe.landings.slice(1)) expect(flights.some(flight => Math.abs(flight.base + flight.rise - floor) < 1e-8)).toBe(true)
    expect(flights.every(flight => flight.riser <= recipe.maxRiser && flight.tread >= recipe.minTread && flight.rise <= recipe.maxFlightRise)).toBe(true)
    const stair = element('stair', { kind: 'stair', dimensions, stair: recipe })
    const mesh = compilePhysicalObjects({ source: source([stair]), bindings: [] })[0]!
    expect(mesh.positions.every(Number.isFinite)).toBe(true)
    expect(mesh.positions.length / 9).toBeLessThan(5000)
    expect(() => source([element('bad-stair', { kind: 'stair', dimensions, stair: { ...recipe, landings: [0, 21] } })])).toThrow('exact authored rise')
    expect(() => source([element('bad-stair', { kind: 'stair', dimensions, stair: { ...recipe, landingDepth: 1.2 } })])).toThrow('at least the flight width')
    expect(() => source([element('bad-stair', { kind: 'stair', dimensions: { ...dimensions, width: 4 }, stair: recipe })])).toThrow('below the authored minimum')
    expect(() => source([element('bad-stair', { kind: 'context', dimensions, stair: recipe })])).toThrow('needs a stair occurrence')
  })
})

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import baseSource from '../src/packs/physical-layout/pwr-turbine-island.source.json'
import baseBindings from '../src/packs/physical-layout/pwr-turbine-island.bindings.json'
import sourceArtifact from '../src/packs/physical-layout/pwr-full-unit.source.json'
import bindingsArtifact from '../src/packs/physical-layout/pwr-full-unit.bindings.json'
import coverageArtifact from '../src/packs/physical-layout/pwr-full-unit.coverage.json'
import { createPwrFullUnitPhysicalArtifacts } from '../src/packs/physical-layout/authoring/pwr-full-unit.ts'
import { composePhysicalArrangement, physicalArrangementSchema } from '../src/packs/physical-layout/authoring/arrangement.ts'
import arrangement from '../src/packs/physical-layout/authoring/pwr-full-unit.arrangement.json'
import { physicalSourceSchema, parameters, physicalStairFlights, type Element, type Source } from '../src/packs/physical-layout/native/campus/source.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from '../src/packs/physical-layout/native/campus/compile-scene.ts'
import { wallCells } from '../src/packs/physical-layout/native/solid.ts'
import { compilePhysicalObjects as compileOriginalObjects } from '../src/packs/physical-layout/native/compile-scene.ts'
import { physicalSourceSchema as originalSourceSchema } from '../src/packs/physical-layout/native/source.ts'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition } from '../src/packs/process-plant/plant-definitions.ts'
import type { Binding } from '../src/packs/physical-layout/authoring/composition.ts'
import historicalTargets from './fixtures/physical-layout/historical-targets-20261029.json'

const artifacts = createPwrFullUnitPhysicalArtifacts()
const source = artifacts.source
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:physical-coverage', loopCount: 4 }))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const box = (source: Source, e: Element) => { const p = parameters(source, e); return { min: e.pose.position, max: [e.pose.position[0] + p.length, e.pose.position[1] + p.width, e.pose.position[2] + p.height] } }
const corners = (element: Element) => {
  const p = parameters(source, element), c = Math.cos(element.pose.yaw), s = Math.sin(element.pose.yaw)
  return [[0, 0], [p.length, 0], [p.length, p.width], [0, p.width]].map(([x, y]) => [element.pose.position[0] + c * x! - s * y!, element.pose.position[1] + s * x! + c * y!] as [number, number])
}
const local = (point: readonly number[], element: Element) => {
  const x = point[0]! - element.pose.position[0], y = point[1]! - element.pose.position[1], c = Math.cos(element.pose.yaw), s = Math.sin(element.pose.yaw)
  return [c * x + s * y, -s * x + c * y]
}
const intersects = (a: Array<[number, number]>, b: Array<[number, number]>) => {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, axis = [q[1] - p[1], p[0] - q[0]]
    const ap = a.map(p => p[0] * axis[0]! + p[1] * axis[1]!), bp = b.map(p => p[0] * axis[0]! + p[1] * axis[1]!)
    if (Math.min(Math.max(...ap), Math.max(...bp)) - Math.max(Math.min(...ap), Math.min(...bp)) < 0.001) return false
  }
  return true
}

describe('Full conceptual PWR unit authoring', () => {
  test('the arrangement is the one editable authority and all retained facets reproduce exactly', () => {
    expect(JSON.stringify(artifacts.source)).toBe(JSON.stringify(sourceArtifact))
    expect(JSON.stringify(artifacts.bindings)).toBe(JSON.stringify(bindingsArtifact))
    expect(JSON.stringify(artifacts.coverage)).toBe(JSON.stringify(coverageArtifact))
    expect(() => physicalArrangementSchema.parse({ ...arrangement, silentNewField: true })).toThrow()
    const changed = structuredClone(arrangement)
    changed.equipment[0]!.position[2] = 0.25
    const next = composePhysicalArrangement(changed, physicalSourceSchema.parse(baseSource), baseBindings as Binding[])
    expect(hash(next.source)).not.toBe(hash(source))
    expect(next.bindings).toEqual(artifacts.bindings)
    expect(baseSource.elements[0]!.pose.position).toEqual([10, 16, 15])
  })

  test('retained coverage keeps its historical graph admission independently of the extended current model', () => {
    const historical = historicalTargets.entries.find(entry => entry.selection.model.parameters.loopCount === 4)!.description
    expect(artifacts.coverage.modelRequirement).toEqual({ modelRef: historical.modelRef, modelDigest: historical.modelDigest })
    expect(plant.modelDigest).not.toBe(historical.modelDigest)
    expect(historical.subjects).toHaveLength(121)
    expect(historical.connections).toHaveLength(167)
    const rows = artifacts.coverage.dispositions
    expect(rows.map(row => row.subjectId).sort()).toEqual(historical.subjects.map(subject => subject.id).sort())
    expect(rows.filter(row => row.disposition === 'direct')).toHaveLength(82)
    expect(rows.filter(row => row.disposition === 'assembly')).toHaveLength(25)
    const bound = new Set(artifacts.bindings.map(binding => binding.elementId))
    expect(bound.size).toBe(108)
    for (const row of rows) {
      expect(row.reason.length).toBeGreaterThan(20)
      if (row.disposition === 'direct' || row.disposition === 'assembly' || row.disposition === 'housed') expect(bound.has(row.subjectId)).toBe(true)
      else expect(bound.has(row.subjectId)).toBe(false)
    }
    expect(rows.find(row => row.subjectId === 'core')?.physicalElementIds).toEqual(['equipment/vessel'])
    expect(rows.find(row => row.subjectId === 'core')?.disposition).toBe('housed')
    expect(artifacts.bindings.find(binding => binding.elementId === 'core')).toEqual({ physicalElementId: 'equipment/vessel', elementId: 'core', relation: 'houses' })
    expect(rows.find(row => row.subjectId === 'offsiteGrid')?.disposition).toBe('boundary')
    expect(source.elements.some(element => element.id === 'equipment/manualReactorTrip')).toBe(false)
    expect(source.elements.some(element => element.id === 'equipment/deltaTChannelA')).toBe(false)
    expect(source.elements.filter(element => element.equipmentKind === 'steam-generator')).toHaveLength(4)
    expect(source.elements.filter(element => element.equipmentKind === 'reactor-coolant-pump')).toHaveLength(4)
  })

  test('the accepted turbine geometry and origin remain byte-equivalent after source composition', () => {
    const accepted = originalSourceSchema.parse(baseSource)
    expect(source.origin).toEqual(accepted.origin)
    const original = compileOriginalObjects({ source: accepted, bindings: baseBindings as Array<{ physicalElementId: string; elementId: string; relation: 'represents' | 'partOf' }> })
    const current = new Map(compilePhysicalObjects(artifacts).map(object => [object.id, object]))
    for (const mesh of original) expect(current.get(mesh.id)).toEqual(mesh)
    for (const old of accepted.elements) {
      const next = source.elements.find(element => element.id === old.id)!
      const { buildingId: _buildingId, ...retained } = next
      expect(retained).toEqual(old)
    }
  })

  test('every authored equipment room contains its occurrence and physical equipment boxes do not intersect', () => {
    const machines = source.elements.filter(element => element.kind === 'equipment')
    const intersections: string[] = []
    for (const machine of machines) {
      const a = box(source, machine)
      expect(machine.pose.yaw).toBe(0)
      for (const id of machine.spaceIds ?? []) {
        const room = source.elements.find(element => element.id === id)!, b = box(source, room)
        for (let axis = 0; axis < 3; axis++) {
          expect(a.min[axis]! >= b.min[axis]! - 0.01).toBe(true)
          expect(a.max[axis]! <= b.max[axis]! + 0.01).toBe(true)
        }
      }
    }
    for (let i = 0; i < machines.length; i++) for (let j = i + 1; j < machines.length; j++) {
      const a = box(source, machines[i]!), b = box(source, machines[j]!)
      if ([0, 1, 2].every(axis => Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!) > 0.1)) intersections.push(`${machines[i]!.id}/${machines[j]!.id}`)
    }
    expect(intersections).toEqual([])
  })

  test('primary equipment fits inside the authored curved containment and remains one spanning occurrence', () => {
    const innerRadius = 29 - 1.1
    const equipment = source.elements.filter(element => element.kind === 'equipment' && element.buildingId === 'building/containment')
    for (const machine of equipment) {
      const b = box(source, machine)
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) expect(Math.hypot(x! + 50, y! - 8)).toBeLessThan(innerRadius)
    }
    expect(source.elements.filter(element => element.id === 'equipment/vessel')).toHaveLength(1)
    expect(parameters(source, source.elements.find(element => element.id === 'equipment/sgA')!).height).toBe(24)
    expect(source.levels.map(level => level.elevation)).toEqual([0, 8, 15, 22])
    expect(source.elements.filter(element => element.kind === 'building')).toHaveLength(11)
    expect(source.elements.filter(element => element.kind === 'space').length).toBeGreaterThan(30)
    expect(source.elements.filter(element => element.kind === 'door').length).toBeGreaterThan(40)
    expect(source.elements.filter(element => element.kind === 'stair')).toHaveLength(9)
  })

  test('containment is a closed faceted boundary with real personnel and equipment-hatch voids', () => {
    const facets = source.elements.filter(element => element.id.startsWith('wall/containment/facet-'))
    expect(facets).toHaveLength(32)
    expect(source.elements.some(element => element.id === 'building/containment/shell')).toBe(false)
    for (let i = 0; i < facets.length; i++) {
      const e = facets[i]!, next = facets[(i + 1) % facets.length]!, p = parameters(source, e)
      const end = [e.pose.position[0] + Math.cos(e.pose.yaw) * p.length, e.pose.position[1] + Math.sin(e.pose.yaw) * p.length]
      expect(end[0]).toBeCloseTo(next.pose.position[0], 10)
      expect(end[1]).toBeCloseTo(next.pose.position[1], 10)
      const radius = Math.hypot(end[0]! + 50, end[1]! - 8), inside = [end[0]! - (end[0]! + 50) / radius * 0.3, end[1]! - (end[1]! - 8) / radius * 0.3]
      for (const wall of [e, next]) {
        const v = local(inside, wall), d = parameters(source, wall)
        expect(v[0]! >= -0.001 && v[0]! <= d.length + 0.001 && v[1]! >= -0.001 && v[1]! <= d.width + 0.001).toBe(true)
      }
    }
    for (const id of ['opening/containment/personnel', 'opening/containment/equipment-hatch']) {
      const opening = source.elements.find(element => element.id === id)!, host = source.elements.find(element => element.id === opening.hostId)!, h = parameters(source, host), o = parameters(source, opening)
      const cells = wallCells(source as unknown as Parameters<typeof wallCells>[0], host as unknown as Parameters<typeof wallCells>[1])
      expect(cells.reduce((sum, cell) => sum + cell.length * cell.height, 0)).toBeCloseTo(h.length * h.height - o.length * o.height, 6)
      expect(source.elements.filter(element => element.fillsId === id)).toHaveLength(1)
      if (id.endsWith('equipment-hatch')) { expect(o.length).toBe(7); expect(o.height).toBe(8) }
    }
    const vestibule = source.elements.find(element => element.id === 'building/containment-personnel-vestibule')!
    const approach = source.elements.find(element => element.id === 'access/containment-to-gallery')!
    for (const machine of source.elements.filter(element => element.kind === 'equipment' && element.pose.position[2] < 3.5)) {
      expect(intersects(corners(vestibule), corners(machine))).toBe(false)
      expect(intersects(corners(approach), corners(machine))).toBe(false)
    }
  })

  test('new stairs have credible bounded flights, floor landings and actual shaft voids', () => {
    const stairs = source.elements.filter(element => element.kind === 'stair' && element.id !== 'stair/main')
    for (const stair of stairs) {
      const p = parameters(source, stair)
      expect(stair.stair).toBeDefined()
      const flights = physicalStairFlights(p, stair.stair!)
      expect(stair.stair!.landingDepth).toBeGreaterThanOrEqual(1.5)
      expect(stair.stair!.landingDepth).toBeGreaterThanOrEqual(stair.stair!.flightWidth)
      expect(flights.every(flight => flight.riser <= 0.175 && flight.tread >= 0.28)).toBe(true)
      expect(flights.at(-1)!.base + flights.at(-1)!.rise).toBe(p.height)
      const slabs = source.elements.filter(element => element.kind === 'slab' && element.buildingId === stair.buildingId && element.dependsOn?.includes(stair.id))
      expect(slabs.length).toBeGreaterThan(0)
      for (const slab of slabs) {
        expect(slab.holes?.length).toBeGreaterThan(0)
        const point = corners(stair).map(point => local(point, slab)), plate = parameters(source, slab)
        const xmin = Math.max(0, Math.min(...point.map(p => p[0]!))), xmax = Math.min(plate.length, Math.max(...point.map(p => p[0]!)))
        const ymin = Math.max(0, Math.min(...point.map(p => p[1]!))), ymax = Math.min(plate.width, Math.max(...point.map(p => p[1]!)))
        const midpoint = [(xmin + xmax) / 2, (ymin + ymax) / 2]
        expect(slab.holes!.some(hole => midpoint[0]! >= hole.x - 0.001 && midpoint[0]! <= hole.x + hole.length + 0.001 && midpoint[1]! >= hole.y - 0.001 && midpoint[1]! <= hole.y + hole.width + 0.001)).toBe(true)
      }
    }
    expect(source.elements.find(element => element.id === 'building/electrical-control/floor/service')?.dependsOn).toEqual(['stair/electrical-lower'])
    expect(source.elements.find(element => element.id === 'building/electrical-control/floor/operating')?.dependsOn).toEqual(['stair/electrical-upper'])
    expect(source.elements.find(element => element.id === 'platform/containment/operating/ring-08')?.dependsOn).toEqual(['stair/containment-middle'])
    expect(source.elements.filter(element => element.kind === 'equipment' && artifacts.bindings.some(binding => binding.physicalElementId === element.id && String(binding.elementId).includes('Breaker'))).every(element => element.equipmentKind === 'cabinet')).toBe(true)
  })

  test('connected containment platforms clear tall machinery, shell and crossing risers', () => {
    const platforms = source.elements.filter(element => element.id.startsWith('platform/containment/'))
    for (const level of ['service', 'operating', 'refuelling']) {
      const ring = source.elements.filter(element => element.id.startsWith(`platform/containment/${level}/ring-`))
      expect(ring).toHaveLength(16)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, next = ring[(i + 1) % ring.length]!, p = parameters(source, a)
        expect(a.pose.position[0] + Math.cos(a.pose.yaw) * p.length).toBeCloseTo(next.pose.position[0], 10)
        expect(a.pose.position[1] + Math.sin(a.pose.yaw) * p.length).toBeCloseTo(next.pose.position[1], 10)
      }
    }
    for (const slab of platforms) {
      const p = parameters(source, slab), top = slab.pose.position[2] + p.height
      expect(corners(slab).every(point => Math.hypot(point[0] + 50, point[1] - 8) < 27.3)).toBe(true)
      for (const machine of source.elements.filter(element => element.kind === 'equipment')) {
        const m = parameters(source, machine)
        if (machine.pose.position[2] < top - 0.001 && machine.pose.position[2] + m.height > slab.pose.position[2] + 0.001) expect(intersects(corners(slab), corners(machine))).toBe(false)
      }
      for (const pipe of source.elements.filter(element => element.kind === 'pipe')) for (let i = 0; i < pipe.path!.length - 1; i++) {
        const a = pipe.path![i]!, b = pipe.path![i + 1]!
        if (a[2] === b[2] || top <= Math.min(a[2], b[2]) || top >= Math.max(a[2], b[2])) continue
        const ratio = (top - a[2]) / (b[2] - a[2]), point = local([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio], slab)
        expect(point[0]! <= 0 || point[0]! >= p.length || point[1]! <= 0 || point[1]! >= p.width || slab.holes?.some(hole => point[0]! >= hole.x && point[0]! <= hole.x + hole.length && point[1]! >= hole.y && point[1]! <= hole.y + hole.width)).toBe(true)
      }
    }
  })

  test('unbound geometry has explicit context provenance and no fabricated operational identity', () => {
    const bound = new Set(artifacts.bindings.map(binding => binding.physicalElementId))
    const context = artifacts.coverage.contextElements
    expect(context.map(row => row.physicalElementId).sort()).toEqual(source.elements.filter(element => !bound.has(element.id)).map(element => element.id).sort())
    expect(context.every(row => row.reason.length > 20)).toBe(true)
    expect(context.find(row => row.physicalElementId === 'msr-1')?.reason).toContain('no independent MSR subject')
    expect(context.find(row => row.physicalElementId === 'equipment/control-console')?.reason).toContain('no operational correspondence')
    expect(artifacts.coverage.evidence.accuracy).toBe('illustrative')
  })

  test('bounded reusable families and routes produce a practical native scene', () => {
    const objects = compilePhysicalObjects(artifacts), bounds = physicalObjectsBounds(objects)
    expect(objects.length).toBeGreaterThan(420)
    expect(objects.length).toBeLessThan(500)
    expect(objects.reduce((sum, object) => sum + object.positions.length / 9, 0)).toBeLessThan(110_000)
    expect(JSON.stringify(source).length).toBeLessThan(210_000)
    expect(source.types.length).toBeLessThan(45)
    expect(bounds.max[0] - bounds.min[0]).toBeLessThan(300)
    expect(bounds.max[1] - bounds.min[1]).toBeLessThan(170)
    expect(bounds.max[2]).toBe(48)
    for (const letter of ['A', 'B', 'C', 'D']) for (const prefix of ['hot-leg', 'cold-leg', 'rcp-return']) expect(source.elements.some(element => element.id === `route/${prefix}-${letter}`)).toBe(true)
    expect(source.elements.some(element => element.id === 'route/hot-leg-E')).toBe(false)
  })
})

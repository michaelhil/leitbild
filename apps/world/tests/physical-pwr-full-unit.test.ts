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
import { physicalSourceSchema, parameters, type Element, type Source } from '../src/packs/physical-layout/native/campus/source.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from '../src/packs/physical-layout/native/campus/compile-scene.ts'
import { compilePhysicalObjects as compileOriginalObjects } from '../src/packs/physical-layout/native/compile-scene.ts'
import { physicalSourceSchema as originalSourceSchema } from '../src/packs/physical-layout/native/source.ts'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition } from '../src/packs/process-plant/plant-definitions.ts'
import type { Binding } from '../src/packs/physical-layout/authoring/composition.ts'

const artifacts = createPwrFullUnitPhysicalArtifacts()
const source = artifacts.source
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:physical-coverage', loopCount: 4 }))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const box = (source: Source, e: Element) => { const p = parameters(source, e); return { min: e.pose.position, max: [e.pose.position[0] + p.length, e.pose.position[1] + p.width, e.pose.position[2] + p.height] } }

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

  test('the exact current graph is partitioned without inventing physical machines for its logical functions', () => {
    expect(plant.modelDigest).toBe(artifacts.coverage.modelRequirement.modelDigest)
    expect(plant.sourceGraph.components).toHaveLength(121)
    expect(plant.sourceGraph.connections).toHaveLength(167)
    const rows = artifacts.coverage.dispositions
    expect(rows.map(row => row.subjectId).sort()).toEqual(plant.sourceGraph.components.map(component => String(component.id)).sort())
    expect(rows.filter(row => row.disposition === 'direct')).toHaveLength(82)
    expect(rows.filter(row => row.disposition === 'assembly')).toHaveLength(25)
    const bound = new Set(artifacts.bindings.map(binding => binding.elementId))
    expect(bound.size).toBe(107)
    for (const row of rows) {
      expect(row.reason.length).toBeGreaterThan(20)
      if (row.disposition === 'direct' || row.disposition === 'assembly') expect(bound.has(row.subjectId)).toBe(true)
      else expect(bound.has(row.subjectId)).toBe(false)
    }
    expect(rows.find(row => row.subjectId === 'core')?.physicalElementIds).toEqual(['equipment/vessel'])
    expect(rows.find(row => row.subjectId === 'offsiteGrid')?.disposition).toBe('boundary')
    expect(source.elements.some(element => element.id === 'equipment/manualReactorTrip')).toBe(false)
    expect(source.elements.some(element => element.id === 'equipment/deltaTChannelA')).toBe(false)
    expect(source.elements.filter(element => element.equipmentKind === 'steam-generator')).toHaveLength(4)
    expect(source.elements.filter(element => element.equipmentKind === 'reactor-coolant-pump')).toHaveLength(4)
  })

  test('the accepted turbine geometry and origin remain byte-equivalent after source composition', () => {
    const accepted = originalSourceSchema.parse(baseSource)
    expect(source.origin).toEqual(accepted.origin)
    const original = compileOriginalObjects({ source: accepted, bindings: baseBindings as Binding[] })
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
    expect(source.elements.filter(element => element.kind === 'building')).toHaveLength(10)
    expect(source.elements.filter(element => element.kind === 'space').length).toBeGreaterThan(30)
    expect(source.elements.filter(element => element.kind === 'door').length).toBeGreaterThan(40)
    expect(source.elements.filter(element => element.kind === 'stair')).toHaveLength(6)
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
    expect(objects).toHaveLength(356)
    expect(objects.reduce((sum, object) => sum + object.positions.length / 9, 0)).toBeLessThan(110_000)
    expect(JSON.stringify(source).length).toBeLessThan(160_000)
    expect(source.types.length).toBeLessThan(45)
    expect(bounds.max[0] - bounds.min[0]).toBeLessThan(300)
    expect(bounds.max[1] - bounds.min[1]).toBeLessThan(170)
    expect(bounds.max[2]).toBe(48)
    for (const letter of ['A', 'B', 'C', 'D']) for (const prefix of ['hot-leg', 'cold-leg', 'rcp-return']) expect(source.elements.some(element => element.id === `route/${prefix}-${letter}`)).toBe(true)
    expect(source.elements.some(element => element.id === 'route/hot-leg-E')).toBe(false)
  })
})

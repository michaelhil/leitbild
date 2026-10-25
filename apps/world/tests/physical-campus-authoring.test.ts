import { describe, expect, test } from 'bun:test'
import arrangement from '../src/packs/physical-layout/pwr-campus.arrangement.json'
import savedSource from '../src/packs/physical-layout/pwr-campus.source.json'
import savedBindings from '../src/packs/physical-layout/pwr-campus.bindings.json'
import savedCoverage from '../src/packs/physical-layout/pwr-campus.coverage.json'
import { campusArrangementSchema, composeCampus, localPointAtAnchor } from '../src/packs/physical-layout/native/campus/author-campus.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from '../src/packs/physical-layout/native/campus/compile-scene.ts'
import { localMercatorMatrix, inverse, multiply, transform } from '../src/ui/map/physical-scene/math.ts'
import { packPhysicalSceneSchema } from '../src/core/packs/scene.ts'

const authored = campusArrangementSchema.parse(arrangement)
const data = composeCampus(authored)

describe('Authored shared PWR campus and graph coverage', () => {
  test('one strict authored arrangement deterministically reproduces accepted source, correspondence and coverage', () => {
    expect(JSON.stringify(data.source)).toBe(JSON.stringify(savedSource))
    expect(JSON.stringify(data.bindings)).toBe(JSON.stringify(savedBindings))
    expect(JSON.stringify(data.coverage)).toBe(JSON.stringify(savedCoverage))
    expect(() => composeCampus({ ...arrangement, quickFix: true })).toThrow()
  })
  test('the site binds exactly one bus, all four unit connections and all six existing offsite circuits', () => {
    const subjects = data.coverage.dispositions.map(item => item.subjectId)
    expect(subjects).toHaveLength(11)
    expect(subjects.filter(id => id.startsWith('unit-'))).toHaveLength(4)
    expect(subjects.filter(id => id.startsWith('branch:'))).toHaveLength(6)
    expect(subjects).toContain('bus:curated-halden-pwr-switchyard@420')
    const ledgerIds = new Set([...data.coverage.contextElements.map(item => item.physicalElementId), ...data.bindings.map(item => item.physicalElementId)])
    expect(ledgerIds.size).toBe(data.source.elements.length)
    expect(data.source.elements.every(element => ledgerIds.has(element.id))).toBe(true)
    expect(data.coverage.contextElements.filter(item => item.physicalElementId.startsWith('pylon/'))).toHaveLength(4)
  })
  test('six circuits use four authored first supports, with shared support identity and phase continuity', () => {
    const supportCircuits = new Map<string, Set<string>>()
    for (const wire of data.source.elements.filter(element => element.kind === 'conductor' && element.terminatesBeyond)) {
      expect(wire.supportIds).toHaveLength(1)
      expect(wire.installation).toBe('overhead')
      const target = data.bindings.find(binding => binding.physicalElementId === wire.id)!.elementId
      const subjects = supportCircuits.get(wire.supportIds![0]!) ?? new Set<string>()
      subjects.add(target); supportCircuits.set(wire.supportIds![0]!, subjects)
      const circuitId = wire.id.split('/')[1]!.replace(/-phase-[1-3]$/, '')
      const phase = Number(wire.id.at(-1))
      const bayPhase = data.source.elements.find(element => element.id === `yard/${circuitId}/phase-${phase}`)!
      expect(wire.path![0]).toEqual(bayPhase.path!.at(-1))
    }
    expect(supportCircuits.size).toBe(4)
    expect([...supportCircuits.values()].map(set => set.size).sort()).toEqual([1, 1, 2, 2])
    expect(data.source.elements.filter(element => element.terminatesBeyond)).toHaveLength(18)
    expect(data.source.elements.filter(element => element.equipmentKind === 'pylon').every(element => !data.bindings.some(binding => binding.physicalElementId === element.id))).toBe(true)
  })
  test('unit conductor corridors terminate at the existing unit transformer in the exact shared map projection', () => {
    for (const unit of authored.units) {
      const matrix = multiply(inverse(localMercatorMatrix(authored.siteAnchor, 0)), localMercatorMatrix(unit.anchor, 0))
      const expected = transform(matrix, authored.unitTerminal), projected = localPointAtAnchor(authored.siteAnchor, unit.anchor, authored.unitTerminal)
      for (const axis of [0, 1, 2]) expect(projected[axis]).toBeCloseTo(expected[axis]!, 6)
      const wire = data.source.elements.find(element => element.id === `conductor/${unit.role}-phase-2`)!
      for (const axis of [0, 1, 2]) expect(wire.path!.at(-1)![axis]).toBeCloseTo(expected[axis]!, 5)
      expect(wire.path![0]).toEqual(data.source.elements.find(element => element.id === `yard/${unit.role}/phase-2`)!.path!.at(-1))
    }
  })
  test('administration, parking, gate and roads remain context without fake operational objects', () => {
    expect(data.source.elements.filter(element => element.kind === 'building')).toHaveLength(5)
    expect(data.source.elements.some(element => element.id === 'administration/1/floor')).toBe(true)
    expect(data.source.elements.find(element => element.id === 'administration/1/floor')!.holes).toEqual([{ x: 58, y: 21, length: 4.6, width: 7.8 }])
    expect(data.source.elements.some(element => element.id === 'administration/1/entry-door')).toBe(false)
    expect(data.source.elements.filter(element => element.id.startsWith('parking/line-'))).toHaveLength(84)
    expect(data.source.elements.filter(element => element.kind === 'road')).toHaveLength(12)
    const contextualPrefixes = ['building/', 'parking/', 'gate/', 'road/', 'fence/']
    expect(data.bindings.every(binding => !contextualPrefixes.some(prefix => binding.physicalElementId.startsWith(prefix)))).toBe(true)
    const northFence = data.source.elements.find(element => element.id === 'fence/campus')!.path!.at(-1)!
    const southFence = data.source.elements.find(element => element.id === 'fence/campus-entrance-return')!.path![0]!
    expect(northFence[1] - southFence[1]).toBe(16)
    const entranceRoad = data.source.elements.find(element => element.id === 'road/common-0')!.path!
    expect(entranceRoad[0]![0]).toBeLessThan(authored.entrance.position[0])
    expect(entranceRoad[1]![0]).toBeGreaterThan(authored.entrance.position[0])
  })
  test('campus delivery stays within the admitted bounded scene budget and declares no source geometry beyond first supports', () => {
    const objects = compilePhysicalObjects(data), bounds = physicalObjectsBounds(objects)
    const scene = packPhysicalSceneSchema.parse({ id: 'campus', revision: 'campus', targetObjectId: 'grid', anchor: data.source.siteAnchor!, bearing: 0, bounds, levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })), objects })
    expect(scene.objects.length).toBeLessThan(1000)
    expect(scene.objects.reduce((count, object) => count + object.positions.length / 9, 0)).toBeLessThan(150_000)
    expect(bounds.max[0] - bounds.min[0]).toBeLessThan(1800)
    expect(bounds.max[1] - bounds.min[1]).toBeLessThan(1400)
    const changed = structuredClone(authored)
    changed.switchyard.circuits[0]!.supportId = 'not-authored'
    expect(() => composeCampus(changed)).toThrow('Unknown first support')
  })
})

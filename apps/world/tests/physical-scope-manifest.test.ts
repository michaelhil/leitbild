import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema } from '../src/core/packs/scene.ts'
import { physicalScopeManifest, type PhysicalScopeSource } from '../src/packs/physical-layout/scope-manifest.ts'

const source: PhysicalScopeSource = {
  id: 'fixture', title: 'Scope fixture', origin: [10, 20, 0], rootScope: { id: 'unit', label: 'Unit', kind: 'unit' },
  levels: [{ id: 'ground', elevation: 0 }, { id: 'upper', elevation: 8 }], types: [],
  elements: [
    { id: 'building', label: 'Building', kind: 'building', pose: { position: [10, 20, 0], yaw: Math.PI / 2 }, dimensions: { length: 10, width: 5, height: 20 } },
    { id: 'room', label: 'Room', kind: 'space', buildingId: 'building', pose: { position: [10, 20, 0], yaw: 0 }, dimensions: { length: 5, width: 5, height: 20 } },
    { id: 'vessel', label: 'Vessel housing', kind: 'equipment', buildingId: 'building', spaceIds: ['room'], pose: { position: [10, 20, 0], yaw: 0 } },
    { id: 'outdoor', label: 'First pylon', kind: 'equipment', pose: { position: [10, 20, 0], yaw: 0 } },
  ],
}
const physical = (id: string, levelId: string) => ({ id, label: id, kind: 'equipment', levelId, positions: [0, 0, 0, 1, 0, 16, 0, 1, 0], subjectIds: [id === 'vessel' ? 'core' : 'circuit'] })

test('housed spanning subject retains one occurrence across floor views and declared memberships', () => {
  const result = physicalScopeManifest(source, [physical('vessel', 'ground'), physical('outdoor', 'site')])
  expect(result.objects[0]!.scopeIds).toEqual(['unit', 'building', 'room'])
  expect(result.objects[0]!.levelIds).toEqual(['ground', 'upper'])
  expect(result.objects[0]!.subjectIds).toEqual(['core'])
  expect(result.objects[1]!.levelIds).toEqual(['site'])
  expect(result.scopes.find(scope => scope.id === 'building')!.bounds.min[0]).toBeCloseTo(-5)
  expect(result.scopes.find(scope => scope.id === 'room')!.parentId).toBe('building')
})

test('scene admission refuses invented membership and cyclic scope ancestry', () => {
  const data = physicalScopeManifest(source, [physical('vessel', 'ground')])
  const scene = { id: 'layout', revision: 'revision', targetObjectId: 'owner', anchor: [0, 0], bearing: 0, bounds: { min: [-5, 0, 0], max: [5, 10, 20] }, levels: source.levels.map(level => ({ ...level, label: level.id, cutHeight: level.elevation + 3 })), ...data }
  expect(packPhysicalSceneSchema.safeParse(scene).success).toBe(true)
  expect(packPhysicalSceneSchema.safeParse({ ...scene, objects: [{ ...data.objects[0], scopeIds: ['invented'] }] }).success).toBe(false)
  expect(packPhysicalSceneSchema.safeParse({ ...scene, scopes: data.scopes.map(scope => scope.id === 'unit' ? { ...scope, parentId: 'room' } : scope) }).success).toBe(false)
})

import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalSceneScope } from '../src/core/packs/scene.ts'
import { physicalScopeMembers } from '../src/ui/map/physical-scene/scopes.ts'
import { physicalOccurrenceInScope } from '../src/ui/physical-layout/explorer-model.ts'
import { visiblePhysicalPlanAnnotations } from '../src/ui/physical-layout/plan-annotations.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const box = (x: number) => ({ min: [x, 0, 0] as [number, number, number], max: [x + 10, 10, 10] as [number, number, number] })
const scopes: PhysicalSceneScope[] = [
  { id: 'unit', kind: 'unit', label: 'Unit', bounds: { min: [0, 0, 0], max: [50, 10, 10] }, levelIds: ['ground', 'deck'] },
  { id: 'hall', kind: 'building', label: 'Hall', parentId: 'unit', bounds: box(0), levelIds: ['ground', 'deck'] },
  { id: 'annex', kind: 'building', label: 'Annex', parentId: 'unit', bounds: box(10), levelIds: ['ground'] },
  { id: 'other', kind: 'building', label: 'Other', parentId: 'unit', bounds: box(30), levelIds: ['ground'] },
  { id: 'room', kind: 'space', label: 'Room', parentId: 'annex', bounds: box(10), levelIds: ['ground'] },
  { id: 'inspection', kind: 'area', label: 'Conventional island', parentId: 'unit', members: ['hall', 'annex'], bounds: { min: [0, 0, 0], max: [20, 10, 10] }, levelIds: ['ground', 'deck'], inspectionView: { bearing: 140, pitch: 58, target: [10, 5, 8] } },
]
const scene = (): PackPhysicalScene => ({ id: 'site', revision: 'r', targetObjectId: 'plant', anchor: [0, 0], bearing: 0, bounds: scopes[0]!.bounds, scopes: structuredClone(scopes), levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 1.2 }, { id: 'deck', label: 'Deck', elevation: 5, cutHeight: 6.2 }], objects: [], planAnnotations: [{ id: 'room-label', kind: 'label', role: 'space', text: 'Annex room', anchor: [15, 5, 0], rotation: 0, scopeIds: ['room'], levelIds: ['ground'] }] })
test('composite inspection areas include descendants of both buildings without changing physical membership', () => {
  const before = JSON.stringify(scopes), members = physicalScopeMembers(scopes, 'inspection')
  expect([...members].sort()).toEqual(['annex', 'hall', 'inspection', 'room'])
  expect(physicalScopeMembers(scopes, 'inspection')).toBe(members)
  expect(physicalOccurrenceInScope({ scopeIds: ['unit', 'annex', 'room'] }, 'inspection', scopes)).toBe(true)
  expect(physicalOccurrenceInScope({ scopeIds: ['unit', 'other'] }, 'inspection', scopes)).toBe(false)
  const value = scene()
  expect(visiblePhysicalPlanAnnotations(value, defaultPhysicalSceneView(value.levels), 'inspection').map(annotation => annotation.id)).toEqual(['room-label'])
  expect(JSON.stringify(scopes)).toBe(before)
  expect(packPhysicalSceneSchema.safeParse(value).success).toBe(true)
})
test('area references, derived bounds/levels and Home angles are validated at scene admission', () => {
  for (const change of [
    (area: PhysicalSceneScope) => { area.members = ['absent'] },
    (area: PhysicalSceneScope) => { area.members = ['inspection'] },
    (area: PhysicalSceneScope) => { area.members = ['hall', 'hall'] },
    (area: PhysicalSceneScope) => { area.bounds.max[0] = 40 },
    (area: PhysicalSceneScope) => { area.levelIds = ['ground'] },
    (area: PhysicalSceneScope) => { area.inspectionView!.pitch = 90 },
  ]) { const value = scene(); change(value.scopes!.at(-1)!); expect(packPhysicalSceneSchema.safeParse(value).success).toBe(false) }
  const value = scene(); value.scopes![1]!.members = ['annex']; expect(packPhysicalSceneSchema.safeParse(value).success).toBe(false)
})

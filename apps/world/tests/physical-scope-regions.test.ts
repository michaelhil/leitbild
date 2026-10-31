import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../src/core/packs/scene.ts'
import { physicalScopeRegions, disjointPhysicalScopeRegions, physicalScopeBoundaryFaces } from '../src/ui/map/physical-scene/scope-regions.ts'

const hall: PhysicalSceneBounds = { min: [0, 0, 0], max: [10, 4, 4] }, annex: PhysicalSceneBounds = { min: [8, 2, 0], max: [14, 8, 4] }
const source: Pick<PackPhysicalScene, 'scopes'> = { scopes: [
  { id: 'unit', label: 'Unit', kind: 'unit', bounds: { min: [-100, -100, 0], max: [100, 100, 40] }, levelIds: ['floor'] },
  { id: 'hall', label: 'Hall', kind: 'building', parentId: 'unit', bounds: hall, levelIds: ['floor'] },
  { id: 'annex', label: 'Annex', kind: 'building', parentId: 'unit', bounds: annex, levelIds: ['floor'] },
  { id: 'area', label: 'Hall and annex', kind: 'area', parentId: 'unit', bounds: { min: [0, 0, 0], max: [14, 8, 4] }, levelIds: ['floor'], members: ['hall', 'annex'] },
] }
test('selected inspection regions are member unions, never an implicit whole-unit ancestor or enclosing box', () => {
  expect(physicalScopeRegions(source)).toEqual([])
  expect(physicalScopeRegions(source, 'hall')).toEqual([hall])
  expect(physicalScopeRegions(source, 'area')).toEqual([hall, annex])
  expect(() => physicalScopeRegions(source, 'missing')).toThrow('Unknown physical inspection scope')
})
test('overlapping spatial members partition without positive overlap and shared faces never cap routes', () => {
  const pieces = disjointPhysicalScopeRegions([hall, annex]), volume = pieces.reduce((sum, box) => sum + box.min.reduce((v, min, axis) => v * (box.max[axis]! - min), 1), 0)
  expect(volume).toBe(288)
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) expect([0, 1, 2].every(axis => Math.min(pieces[i]!.max[axis]!, pieces[j]!.max[axis]!) > Math.max(pieces[i]!.min[axis]!, pieces[j]!.min[axis]!))).toBe(false)
  const boundary = physicalScopeBoundaryFaces(pieces), area = boundary.reduce((sum, face) => sum + (face.max[0] - face.min[0]) * (face.max[1] - face.min[1]), 0)
  expect(area).toBe(320)
  expect(physicalScopeBoundaryFaces(disjointPhysicalScopeRegions([hall, hall]))).toHaveLength(6)
})

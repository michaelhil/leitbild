import { expect, test } from 'bun:test'
import type { PhysicalSceneScope } from '../src/core/packs/scene.ts'
import { levelForPhysicalFocus, levelForScopeFocus, physicalOccurrenceInScope, physicalOccurrenceOnLevel } from '../src/ui/physical-layout/explorer-model.ts'
import { initialPhysicalLayoutView } from '../src/ui/physical-layout/view.ts'

const scopes: PhysicalSceneScope[] = [
  { id: 'unit', label: 'Unit', kind: 'unit', bounds: { min: [0, 0, 0], max: [30, 30, 30] }, levelIds: ['ground', 'service'] },
  { id: 'containment', parentId: 'unit', label: 'Containment', kind: 'building', bounds: { min: [0, 0, 0], max: [20, 20, 30] }, levelIds: ['ground', 'service'] },
  { id: 'vessel-housing', parentId: 'containment', label: 'Vessel housing', kind: 'assembly', bounds: { min: [5, 5, 0], max: [10, 10, 20] }, levelIds: ['ground', 'service'] },
]
test('source membership connects housed equipment to its assembly and building without a name heuristic', () => {
  const housed = { scopeIds: ['vessel-housing'] }
  expect(physicalOccurrenceInScope(housed, 'containment', scopes)).toBe(true)
  expect(physicalOccurrenceInScope(housed, 'unit', scopes)).toBe(true)
  expect(physicalOccurrenceInScope(housed, 'another-building', scopes)).toBe(false)
  expect(physicalOccurrenceInScope({ scopeIds: undefined }, 'containment', scopes)).toBe(false)
})
test('focus preserves an intersecting floor for spanning machinery and requests a choice otherwise', () => {
  const equipment = { levelId: 'ground', levelIds: ['ground', 'service'] }
  const view = initialPhysicalLayoutView([{ id: 'ground', label: 'Ground', elevation: 0 }, { id: 'service', label: 'Service', elevation: 8 }])
  expect(levelForPhysicalFocus(equipment, { ...view, levelId: 'service' })).toBe('service')
  expect(levelForPhysicalFocus(equipment, { ...view, levelId: 'outside' })).toBeNull()
  expect(levelForPhysicalFocus(equipment, { ...view, mode: '3d', levelId: 'all' })).toBe('all')
  expect(physicalOccurrenceOnLevel({ levelId: 'site' }, 'service')).toBe(true)
})
test('area focus preserves a valid section, selects a unique floor and asks before changing a multi-floor area', () => {
  const current = initialPhysicalLayoutView([{ id: 'ground', label: 'Ground', elevation: 0 }])
  expect(levelForScopeFocus(['ground', 'upper'], current)).toBe('ground')
  expect(levelForScopeFocus(['admin'], current)).toBe('admin')
  expect(levelForScopeFocus(['lower', 'upper'], current)).toBeNull()
  expect(levelForScopeFocus([], current)).toBe('ground')
  expect(levelForScopeFocus(['lower', 'upper'], { ...current, mode: '3d', levelId: 'all' })).toBe('all')
})

import { describe, expect, test } from 'bun:test'
import { physicalInspectionFeatureMetres } from '../src/packs/physical-layout/inspection-feature.ts'

describe('authored automatic inspection scale', () => {
  test('follows actual filled openings, including type/occurrence edits and removed doors', () => {
    const source = { types: [{ id: 'access', parameters: { length: 1.3 } }], elements: [
      { id: 'a', kind: 'opening', typeId: 'access' }, { id: 'a-door', kind: 'door', fillsId: 'a' },
      { id: 'b', kind: 'opening', dimensions: { length: 0.9 } }, { id: 'b-door', kind: 'door', fillsId: 'b', disposition: 'removed' },
      { id: 'trim', kind: 'support', dimensions: { length: 0.005 } },
    ] }
    expect(physicalInspectionFeatureMetres(source)).toBe(1.3)
    expect(physicalInspectionFeatureMetres({ ...source, elements: source.elements.map(element => element.id === 'a' ? { ...element, override: { length: 1.7 } } : element) })).toBe(1.7)
    expect(physicalInspectionFeatureMetres({ ...source, elements: source.elements.map(element => element.id === 'b-door' ? { ...element, disposition: 'installed' } : element) })).toBe(0.9)
  })
  test('does not invent a reveal scale for unfilled, absent or invalid access metadata', () => {
    expect(physicalInspectionFeatureMetres({ types: [], elements: [{ id: 'open', kind: 'opening', dimensions: { length: 2 } }] })).toBeUndefined()
    expect(() => physicalInspectionFeatureMetres({ types: [], elements: [{ id: 'open', kind: 'opening', dimensions: { length: 0 } }, { id: 'door', kind: 'door', fillsId: 'open' }] })).toThrow('Invalid inspection opening width')
  })
})

import { describe, expect, test } from 'bun:test'
import { createEmptyScenarioSource, deepCopy, setValueAtPath, valueAtPath } from '../src/ui/scenario-builder-model.ts'

describe('Scenario Builder model', () => {
  test('keeps map framing in the compact authored view', () => {
    const draft = createEmptyScenarioSource()
    expect(draft.view.map.center).toEqual([10.7522, 59.9139])
    expect(draft.view.map.zoom).toBe(11)
    expect('mapCenter' in draft.world).toBe(false)
  })

  test('reads and writes discovered nested fields without a universal tree model', () => {
    const item = { keyframes: [{ center: [10, 59] }], assembly: { loops: 4 } }
    setValueAtPath(item, ['keyframes', 0, 'center'], [11, 60])
    setValueAtPath(item, ['assembly', 'loops'], 6)
    expect(valueAtPath(item, ['keyframes', 0, 'center'])).toEqual([11, 60])
    expect(valueAtPath(item, ['assembly', 'loops'])).toBe(6)
  })

  test('copies catalog defaults before they enter an editable draft', () => {
    const source = { nested: { value: 1 } }
    const copy = deepCopy(source)
    copy.nested.value = 2
    expect(source.nested.value).toBe(1)
  })
})

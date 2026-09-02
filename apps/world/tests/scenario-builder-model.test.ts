import { describe,expect,test } from 'bun:test'
import { createEmptyScenarioDefinition,deepCopy,newCollectionRow,needsPlacement,setValueAtPath,valueAtPath } from '../src/ui/scenario-builder-model.ts'

describe('Scenario Builder model', () => {
  test('cancelling placement preserves assets positioned by reference', () => {
    const placement = { kind: 'point' as const, path: ['position'], orReference: ['atObject'] }
    expect(needsPlacement({}, placement)).toBe(true)
    expect(needsPlacement({ position: [11, 59] }, placement)).toBe(false)
    expect(needsPlacement({ atObject: 'hospital' }, placement)).toBe(false)
    expect(needsPlacement({}, undefined)).toBe(false)
  })
  test('keeps map framing in the compact authored view', () => {
    const draft = createEmptyScenarioDefinition()
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
  test('reset removes optional values and empty parents, not sparse array coordinates', () => {
    const value: Record<string, unknown> = { atmosphere: { temperatureC: 12 }, keyframes: [{ atSeconds: 30, center: [11, 59] }] }
    setValueAtPath(value, ['atmosphere', 'temperatureC'], undefined)
    setValueAtPath(value, ['keyframes', 0, 'center', 0], undefined)
    expect(value).toEqual({ keyframes: [{ atSeconds: 30 }] })
  })
  test('keyframe append follows the latest time without copying sibling or parent values', () => {
    const collection = { path: ['keyframes'], label: 'Keyframes', defaultItem: { atSeconds: 300 }, fields: [], maxItems: 128, keyframes: { timePath: ['atSeconds'], increment: 300 } }
    expect(newCollectionRow(collection, [{ atSeconds: 600, atmosphere: { temperatureC: -5 } }])).toEqual({ atSeconds: 900 })
    expect(newCollectionRow({ ...collection, keyframes: undefined } as never, [{ atSeconds: 600 }])).toEqual({ atSeconds: 300 })
  })
})

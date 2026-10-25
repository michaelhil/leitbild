import { expect, test } from 'bun:test'
import { railPresentation } from '../src/ui/rail-state.ts'

test('narrow embedded panes keep the map clear without rewriting desktop rail preferences', () => {
  for (const width of [319, 390]) for (const preference of [0, 280, 360, 560]) {
    const narrow = railPresentation(preference, width)
    expect(narrow.drawer).toBe(true)
    expect(narrow.width).toBe(0)
    expect(narrow.panelWidth).toBeLessThanOrEqual(width)
    expect(railPresentation(preference, 1440).width).toBe(preference)
  }
  expect(railPresentation(560, 768).drawer).toBe(true)
  expect(railPresentation(280, 768)).toEqual({ drawer: false, width: 280, panelWidth: 280 })
})

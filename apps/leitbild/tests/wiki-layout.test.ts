import { expect, test } from 'bun:test'
import { navigationWidth, maximumNavigationWidth } from '../src/ui/wiki-layout.ts'

test('navigation resizing preserves both panes and handles stored invalid widths', () => {
  expect(navigationWidth(420, 1400)).toBe(420)
  expect(navigationWidth(900, 1400)).toBe(640)
  expect(navigationWidth(-20, 1400)).toBe(200)
  expect(navigationWidth(NaN, 1400)).toBe(300)
  expect(navigationWidth(Infinity, 1400)).toBe(300)
  expect(navigationWidth(640, 800)).toBe(434)
  expect(maximumNavigationWidth(750)).toBe(384)
  expect(navigationWidth(300, 320)).toBe(200)
})

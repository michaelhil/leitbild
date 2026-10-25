import { expect, test } from 'bun:test'
import type { PackCreateObjectType } from '../src/core/packs/protocol.ts'
import { placementInstruction } from '../src/ui/placement-instruction.ts'

const point = { id: 'weather/probe', label: 'Weather probe', icon: 'Cloud', placementKind: 'point' } as PackCreateObjectType
test('placement instructions exist only for the active lifecycle, so cancel and draft completion cannot leave a stale map hint', () => {
  const trace = [placementInstruction(null, 0), placementInstruction(point, 0), placementInstruction(null, 0)]
  expect(trace).toEqual(['', 'Click map to place new weather probe', ''])
  expect(placementInstruction(null, 2)).toBe('')
})

test('the current route or polygon state supplies its next action without persisting guidance as a command outcome', () => {
  const route = { ...point, placementKind: 'route' as const }, polygon = { ...point, placementKind: 'polygon' as const }
  expect(placementInstruction(route, 0)).toBe('Click start point for new weather probe')
  expect(placementInstruction(route, 1)).toBe('Click end point for new weather probe')
  expect(placementInstruction(polygon, 0)).toBe('Click 3 more points for new weather probe')
  expect(placementInstruction(polygon, 2)).toBe('Click 1 more point for new weather probe')
  expect(placementInstruction(polygon, 3)).toBe('Press Enter to finish weather probe polygon')
})

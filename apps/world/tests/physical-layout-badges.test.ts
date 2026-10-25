import { expect, test } from 'bun:test'
import { sparseLayoutBadges } from '../src/ui/physical-layout/badges.ts'

test('dense explicit targets retain the worst indication at its actual anchor and leave the others to Components', () => {
  const input = [{ id: 'normal', point: { x: 90, y: 90 }, rank: 0 }, { id: 'alarm', point: { x: 94, y: 92 }, rank: 4 }, { id: 'other', point: { x: 240, y: 90 }, rank: 1 }]
  expect(sparseLayoutBadges(input, { width: 400, height: 300 }).map(value => value.id)).toEqual(['alarm', 'other'])
  expect(input[0]!.point).toEqual({ x: 90, y: 90 })
})
test('targets outside the usable map viewport are culled and the target set stays bounded', () => {
  const input = Array.from({ length: 12 }, (_, index) => ({ point: { x: 60 + index * 120, y: 90 }, rank: index }))
  expect(sparseLayoutBadges(input, { width: 1600, height: 200 })).toHaveLength(8)
  expect(sparseLayoutBadges(input, { width: 20, height: 20 })).toHaveLength(0)
})
test('covered targets leave keyboard focus with the visible Components alternative', () => {
  expect(sparseLayoutBadges([{ point: { x: 90, y: 90 }, rank: 4 }], { width: 400, height: 300 }, [{ x: 60, y: 40, width: 200, height: 180 }])).toEqual([])
})

import { expect, test } from 'bun:test'
import { createPhysicalFlowPresentation, type PhysicalFlowMark } from '../src/ui/physical-layout/flow-presentation.ts'

const mark = (key: string, glyph: PhysicalFlowMark['glyph'] = 'forward'): PhysicalFlowMark => ({ kind: 'flow', key, sceneId: 'unit/one', occurrenceId: `pipe/${key}`, elementId: `connection/${key}`, point: { x: 120, y: 80 }, angle: Math.PI / 4, glyph, rank: 0 })

test('fresh readings and unchanged occlusion results retain the exact current drawing intent', () => {
  const proposed = createPhysicalFlowPresentation(), visible = createPhysicalFlowPresentation()
  const first = proposed([mark('steam'), mark('feedwater')]), shown = visible([first[0]!])
  for (let sample = 0; sample < 12; sample++) {
    const latest = proposed([mark('steam'), mark('feedwater')])
    expect(latest).toBe(first)
    expect(visible(latest.filter(value => value.key === 'steam'))).toBe(shown)
  }
})

test('every flow meaning, projection, priority and owner change reaches drawing immediately', () => {
  const updates: Array<(value: PhysicalFlowMark) => PhysicalFlowMark> = [
    ...(['reverse', 'stopped', 'unknown', 'conducting', 'deenergized'] as const).map(glyph => (value: PhysicalFlowMark) => ({ ...value, glyph })),
    value => ({ ...value, point: { ...value.point, x: value.point.x + .25 } }),
    value => ({ ...value, point: { ...value.point, y: value.point.y + .25 } }),
    value => ({ ...value, angle: value.angle + .01 }), value => ({ ...value, rank: value.rank + 1 }),
    value => ({ ...value, key: 'new-projection' }), value => ({ ...value, sceneId: 'unit/two' }),
    value => ({ ...value, occurrenceId: 'pipe/replaced' }), value => ({ ...value, elementId: 'connection/rebound' }),
  ]
  for (const update of updates) {
    const retain = createPhysicalFlowPresentation(), before = retain([mark('steam'), mark('feedwater')]), changed = update(mark('steam'))
    const next = retain([changed, mark('feedwater')])
    expect(next).not.toBe(before)
    expect(next[0]).toBe(changed)
    expect(next[1]).toBe(before[1])
    expect(next[0]).toEqual(changed)
  }
})

test('visibility and ordering remain exact while removed projections leave no history cache', () => {
  const retain = createPhysicalFlowPresentation(), initial = retain([mark('a'), mark('b'), mark('c')])
  const hidden = retain([mark('a'), mark('c')])
  expect(hidden.map(value => value.key)).toEqual(['a', 'c'])
  expect(hidden[0]).toBe(initial[0]); expect(hidden[1]).toBe(initial[2])
  const reversed = retain([mark('c'), mark('a')])
  expect(reversed.map(value => value.key)).toEqual(['c', 'a'])
  expect(reversed[0]).toBe(hidden[1]); expect(reversed[1]).toBe(hidden[0])
  const empty = retain([])
  expect(retain([])).toBe(empty)
  const restored = mark('a')
  expect(retain([restored])[0]).toBe(restored)
  expect(restored).not.toBe(initial[0])
})

test('duplicate projection keys fail explicitly without replacing a valid drawing intent', () => {
  const retain = createPhysicalFlowPresentation(), first = retain([mark('a')])
  expect(() => retain([mark('a'), mark('a', 'reverse')])).toThrow('unique projected mark keys')
  expect(retain([mark('a')])).toBe(first)
})

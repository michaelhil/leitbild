import { describe, expect, test } from 'bun:test'
import { chevronSegment, endStraight, pipeSegments, pipeValue, STUB_STRAIGHT, stubEndSegment } from '../src/ui/embed/vignette/pipe-segments.ts'

describe('pipes as OpenBridge connector-diagram segments', () => {
  test('a bend is a radius-8 corner between straights', () => {
    const segments = pipeSegments('p', [[0, 0], [0, 48], [48, 48]], [], 'open-flow', 'medium')
    expect(segments.map(segment => segment.kind)).toEqual(['straight', 'corner', 'straight'])
    expect(segments[0]).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 40 })
    expect(segments[1]).toMatchObject({ from: { x: 0, y: 40 }, to: { x: 8, y: 48 }, direction: 'BottomLeft' })
    expect(segments[2]).toMatchObject({ x1: 8, y1: 48, x2: 48, y2: 48 })
  })

  test('a crossing leaves a clean 10 px gap in the pipe that passes under', () => {
    const segments = pipeSegments('p', [[24, 96], [24, 0]], [[24, 48]], 'open-flow', 'medium')
    expect(segments).toEqual([
      expect.objectContaining({ kind: 'straight', y1: 96, y2: 53 }),
      expect.objectContaining({ kind: 'straight', y1: 43, y2: 0 }),
    ])
  })

  test('a jog shorter than two radii shares it between its corners: no corner overruns the next, no straight runs backwards', () => {
    const segments = pipeSegments('p', [[0, 0], [48, 0], [48, 6], [96, 6]], [], 'open-flow', 'medium')
    expect(segments.map(segment => segment.kind)).toEqual(['straight', 'corner', 'corner', 'straight'])
    expect(segments[1]).toMatchObject({ from: { x: 45, y: 0 }, to: { x: 48, y: 3 } })
    expect(segments[2]).toMatchObject({ from: { x: 48, y: 3 }, to: { x: 51, y: 6 } })
    for (const segment of segments) if (segment.kind === 'straight') expect(segment.x2 >= segment.x1 && segment.y2 >= segment.y1).toBe(true)
  })

  test('a chevron sits mid-run in flow direction, clear of gaps, and flips for reverse flow', () => {
    expect(chevronSegment('p', [[0, 0], [96, 0]], [], 'open-flow', 'medium', false)).toMatchObject({ kind: 'direction', x: 48, y: 0, direction: 'right' })
    expect(chevronSegment('p', [[0, 0], [96, 0]], [], 'open-flow', 'medium', true)).toMatchObject({ direction: 'left' })
    expect(chevronSegment('p', [[0, 0], [0, 16]], [], 'open-flow', 'medium', false)).toBeNull()
  })

  test('no chevron stands loose: only on a run of two cells, never against a name or a symbol, a third along where the middle is taken', () => {
    expect(chevronSegment('p', [[0, 0], [0, 40]], [], 'open-flow', 'medium', false)).toBeNull()
    // A name beside the middle of the run: the chevron moves a third along, clear of it.
    expect(chevronSegment('p', [[0, 0], [0, 120]], [], 'open-flow', 'medium', false, [{ x: 8, y: 52, width: 60, height: 16 }])).toMatchObject({ x: 0, y: 40 })
    // Text along the whole run: none.
    expect(chevronSegment('p', [[0, 0], [0, 120]], [], 'open-flow', 'medium', false, [{ x: 4, y: 0, width: 60, height: 120 }])).toBeNull()
  })

  test(`a pipe that stops ends on a straight of at least ${STUB_STRAIGHT} px: a last leg too short for one after its bend goes, with its bend (owner finding 4, U-18)`, () => {
    // Hotwell reject: along, then 12 px down to the stop's cell: the leg runs on into the cell, to a straight of 16 after its bend.
    const hotwell: ReadonlyArray<readonly [number, number]> = [[200, 48], [96, 48], [96, 60]]
    const cell = { x: 84, y: 60, width: 24, height: 24 }
    expect(endStraight(hotwell, 'last', cell)).toEqual([[200, 48], [96, 48], [96, 72]])
    expect(stubEndSegment('p', endStraight(hotwell, 'last', cell), 'out', 'empty', 'medium')).toMatchObject({ kind: 'endpoint', x: 96, y: 72, direction: 'bottom' })
    // A cell too shallow for it, or none: the leg and its bend go, and the cap ends the run along, facing on.
    expect(endStraight(hotwell, 'last', { ...cell, height: 8 })).toEqual([[200, 48], [96, 48]])
    expect(endStraight(hotwell, 'last')).toEqual([[200, 48], [96, 48]])
    // From a stop: the first leg.
    expect(endStraight([[96, 60], [96, 48], [200, 48]], 'first', cell)).toEqual([[96, 72], [96, 48], [200, 48]])
    // A leg long enough keeps its bend; a single straight is never cut.
    expect(endStraight([[200, 48], [96, 48], [96, 72]], 'last')).toEqual([[200, 48], [96, 48], [96, 72]])
    expect(endStraight([[0, 0], [0, 8]], 'last')).toEqual([[0, 0], [0, 8]])
    const last = pipeSegments('p', [[200, 48], [96, 48], [96, 72]], [], 'empty', 'medium').at(-1)!
    expect(last).toMatchObject({ kind: 'straight', y1: 56, y2: 72 })
  })

  test('pipe values: hollow for no flow, dashed for unknown, never closed', () => {
    expect([pipeValue('forward'), pipeValue('flowing'), pipeValue('none'), pipeValue('unknown'), pipeValue('dead')]).toEqual(['open-flow', 'open-flow', 'empty', 'closed-dash', 'empty'])
  })

  test('where the drawing stops: OpenBridge\'s end cap facing out, flowing or not; no arrowhead hangs at the end', () => {
    expect(stubEndSegment('p', [[0, 0], [0, -48]], 'out', 'open-flow', 'medium')).toMatchObject({ kind: 'endpoint', x: 0, y: -48, direction: 'top' })
    expect(stubEndSegment('p', [[96, 0], [0, 0]], 'in', 'empty', 'medium')).toMatchObject({ kind: 'endpoint', x: 96, y: 0, direction: 'right' })
  })
})

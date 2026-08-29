import { describe, expect, test } from 'bun:test'
import {
  floatingWindowBoundsForDrag,
  normalizeFloatingWindowBounds,
  type FloatingWindowBounds,
  type FloatingWindowConstraints,
  type FloatingWindowViewport,
} from '../src/ui/window-bounds.ts'

const viewport: FloatingWindowViewport = { width: 800, height: 600 }
const constraints: FloatingWindowConstraints = { minWidth: 48, minHeight: 32, margin: 12 }

const expectBounds = (actual: FloatingWindowBounds, expected: FloatingWindowBounds): void => {
  expect(actual).toEqual(expected)
}

describe('floating window bounds', () => {
  test('preserves the east edge when resizing from the west down to the minimum width', () => {
    const origin: FloatingWindowBounds = { x: 100, y: 80, width: 300, height: 200 }

    const resized = floatingWindowBoundsForDrag({
      mode: 'resize-west',
      origin,
      dx: 500,
      dy: 0,
    }, viewport, constraints)

    expectBounds(resized, { x: 352, y: 80, width: 48, height: 200 })
    expect(resized.x + resized.width).toBe(origin.x + origin.width)
  })

  test('preserves the south and east edges when resizing from the north-west corner', () => {
    const origin: FloatingWindowBounds = { x: 100, y: 80, width: 300, height: 200 }

    const resized = floatingWindowBoundsForDrag({
      mode: 'resize-north-west',
      origin,
      dx: 500,
      dy: 400,
    }, viewport, constraints)

    expectBounds(resized, { x: 352, y: 248, width: 48, height: 32 })
    expect(resized.x + resized.width).toBe(origin.x + origin.width)
    expect(resized.y + resized.height).toBe(origin.y + origin.height)
  })

  test('clamps moves inside the viewport margin', () => {
    const origin: FloatingWindowBounds = { x: 120, y: 100, width: 220, height: 100 }

    expectBounds(floatingWindowBoundsForDrag({
      mode: 'move',
      origin,
      dx: -500,
      dy: 600,
    }, viewport, constraints), { x: 12, y: 488, width: 220, height: 100 })
  })

  test('normalizes non-finite values to valid tiny window bounds', () => {
    expectBounds(normalizeFloatingWindowBounds({
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: Number.NEGATIVE_INFINITY,
    }, viewport, constraints), { x: 12, y: 12, width: 48, height: 32 })
  })
})

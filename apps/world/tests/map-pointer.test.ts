import { describe, expect, test } from 'bun:test'
import { disksPickFor, hoverCardsFor, pickingRadiusFor, touchTargetPx } from '../src/ui/map/map-pointer.ts'
import { operationalIconPx } from '../src/ui/map-runtime/symbol-kit.ts'

describe('map pointer gestures', () => {
  test('hover cards and target previews show for a mouse only, and for nothing before the first pointer', () => {
    expect(hoverCardsFor('mouse')).toBe(true)
    for (const type of ['touch', 'pen', '', null]) expect(hoverCardsFor(type)).toBe(false)
  })

  test('a finger or a pen picks an operational icon anywhere in a 44 px target around it; a mouse, and nothing before the first pointer, picks only under the pointer', () => {
    expect(touchTargetPx).toBe(44)
    for (const type of ['touch', 'pen']) {
      const radius = pickingRadiusFor(type, operationalIconPx)
      expect(radius).toBe(11)
      expect(operationalIconPx + 2 * radius).toBeGreaterThanOrEqual(touchTargetPx)
    }
    expect([pickingRadiusFor('mouse', operationalIconPx), pickingRadiusFor(null, operationalIconPx)]).toEqual([0, 0])
    // An icon already as big as the target needs no radius.
    expect(pickingRadiusFor('touch', 48)).toBe(0)
  })

  test('an icon\'s coloured disk takes a click only while the surface picks targets and the pointer picks exactly; a surface that does not opt in picks the glyph alone for every pointer', () => {
    const radius = (type: string | null) => pickingRadiusFor(type, operationalIconPx)
    expect([null, 'mouse', 'touch', 'pen'].map(type => disksPickFor(false, radius(type)))).toEqual([false, false, false, false])
    expect([null, 'mouse', 'touch', 'pen'].map(type => disksPickFor(true, radius(type)))).toEqual([true, true, false, false])
  })
})

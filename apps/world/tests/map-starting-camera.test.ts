import { describe, expect, test } from 'bun:test'
import { clearCentreFor, panIntoClear, startingZoomFor } from '../src/ui/map/map-camera.ts'

describe('starting camera', () => {
  test('a panel over the map lowers the Starting View\'s zoom so its whole extent fits the clear part', () => {
    // The Board at 960 × 720: 480 px wide plus its 12 px gap leaves 468 px of map.
    const zoom = startingZoomFor(12, { width: 960, height: 720 }, { top: 0, right: 492, bottom: 0, left: 0 })
    expect(2 ** (12 - zoom) * 468).toBeCloseTo(960, 6)
    // The narrower or shorter side decides.
    expect(startingZoomFor(12, { width: 1000, height: 500 }, { top: 250, right: 100, bottom: 0, left: 0 })).toBeCloseTo(11, 6)
  })

  test('nothing over the map, a map with no size yet, or no clear part keeps the authored zoom', () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 }
    expect(startingZoomFor(12, { width: 960, height: 720 }, none)).toBe(12)
    expect(startingZoomFor(12, { width: 0, height: 0 }, { ...none, right: 492 })).toBe(12)
    expect(startingZoomFor(12, { width: 400, height: 720 }, { ...none, right: 492 })).toBe(12)
  })
})

describe('a panel cover changing under an operator-held camera', () => {
  const size = { width: 1366, height: 900 }
  const none = { top: 0, right: 0, bottom: 0, left: 0 }
  // The Dispatch panel docked on the right: 480 px plus its 12 px gap.
  const docked = { ...none, right: 492 }

  test('the camera centres on the middle of the part no panel covers', () => {
    expect(clearCentreFor(size, none)).toEqual([683, 450])
    expect(clearCentreFor(size, docked)).toEqual([437, 450])
    // A bottom sheet below 1024 px covers the lower part.
    expect(clearCentreFor({ width: 768, height: 1024 }, { ...none, bottom: 400 })).toEqual([384, 312])
  })

  test('an object left clear does not move the camera; one the cover would hide pans just far enough to show it', () => {
    expect(panIntoClear([400, 450], size, docked, 48)).toEqual([0, 0])
    // Under the panel: the map moves left until the object stands 48 px inside the clear part's right edge.
    expect(panIntoClear([1100, 450], size, docked, 48)).toEqual([1100 - (1366 - 492 - 48), 0])
    // Under a bottom sheet: the map moves up just as far.
    expect(panIntoClear([384, 900], { width: 768, height: 1024 }, { ...none, bottom: 400 }, 48)).toEqual([0, 900 - (1024 - 400 - 48)])
    // Too near the top edge with nothing covering it.
    expect(panIntoClear([400, 10], size, docked, 48)).toEqual([0, 10 - 48])
  })

  test('on an axis narrower than two margins the object goes to the middle of the clear part', () => {
    expect(panIntoClear([70, 450], { width: 160, height: 900 }, { ...none, right: 80 }, 48)).toEqual([70 - 40, 0])
  })
})

import { describe, expect, test } from 'bun:test'
import { nextDroneWorldStreamDecision } from '../src/ui/drone/drone-scene.ts'

const metersPerDegreeLat = 111_320

const moveEast = (
  center: { readonly lon: number; readonly lat: number },
  meters: number,
): { readonly lon: number; readonly lat: number } => ({
  lon: center.lon + meters / (Math.cos(center.lat * Math.PI / 180) * metersPerDegreeLat),
  lat: center.lat,
})

describe('drone scene world streaming', () => {
  test('requests a new map-derived world after the drone crosses the streaming grid', () => {
    const initial = nextDroneWorldStreamDecision({
      currentCenter: null,
      currentCenterKey: '',
      pendingCenterKey: '',
      desiredCenter: { lon: 10.75, lat: 59.91 },
    })
    expect(initial?.reason).toBe('initial')
    expect(initial).not.toBeNull()
    if (!initial) return

    const stillInsideGrid = nextDroneWorldStreamDecision({
      currentCenter: initial.center,
      currentCenterKey: initial.key,
      pendingCenterKey: '',
      desiredCenter: moveEast(initial.center, 100),
    })
    expect(stillInsideGrid).toBeNull()

    const nextGrid = nextDroneWorldStreamDecision({
      currentCenter: initial.center,
      currentCenterKey: initial.key,
      pendingCenterKey: '',
      desiredCenter: moveEast(initial.center, 500),
    })
    expect(nextGrid?.reason).toBe('grid-crossing')
    expect(nextGrid?.key).not.toBe(initial.key)
  })

  test('does not enqueue duplicate scenery loads while the next grid is pending', () => {
    const initial = nextDroneWorldStreamDecision({
      currentCenter: null,
      currentCenterKey: '',
      pendingCenterKey: '',
      desiredCenter: { lon: 10.75, lat: 59.91 },
    })
    expect(initial).not.toBeNull()
    if (!initial) return
    const nextGrid = nextDroneWorldStreamDecision({
      currentCenter: initial.center,
      currentCenterKey: initial.key,
      pendingCenterKey: '',
      desiredCenter: moveEast(initial.center, 500),
    })
    expect(nextGrid).not.toBeNull()
    if (!nextGrid) return

    const duplicate = nextDroneWorldStreamDecision({
      currentCenter: initial.center,
      currentCenterKey: initial.key,
      pendingCenterKey: nextGrid.key,
      desiredCenter: moveEast(initial.center, 500),
    })
    expect(duplicate).toBeNull()
  })
})

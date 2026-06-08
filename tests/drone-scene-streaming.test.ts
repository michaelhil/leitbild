import { describe, expect, test } from 'bun:test'
import {
  droneWorldLoadSpecsFor,
  nextDroneWorldStreamDecision,
  sceneryBuildLimitsFor,
  selectSceneryTilesForBuild,
} from '../src/ui/drone/drone-scene.ts'
import type { DroneSceneryTileAsset } from '../src/ui/drone/drone-map-world.ts'

const metersPerDegreeLat = 111_320

const moveEast = (
  center: { readonly lon: number; readonly lat: number },
  meters: number,
): { readonly lon: number; readonly lat: number } => ({
  lon: center.lon + meters / (Math.cos(center.lat * Math.PI / 180) * metersPerDegreeLat),
  lat: center.lat,
})

const sceneryTile = (config: {
  readonly id: string
  readonly byteLength: number
  readonly distanceM: number
}): DroneSceneryTileAsset => ({
  id: config.id,
  recipeId: 'drone-urban-flight',
  z: 14,
  x: 1,
  y: 1,
  url: `/map/scenery/current/drone-urban-flight/14/1/1.glb`,
  center: { lon: 10.75, lat: 59.91 },
  localOrigin: { x: config.distanceM, z: 0 },
  distanceM: config.distanceM,
  byteLength: config.byteLength,
  featureCounts: {
    polygons: 1,
    lines: 1,
    labels: 1,
    buildings: 1,
    roads: 1,
    water: 0,
    vegetation: 0,
  },
})

describe('drone scene world streaming', () => {
  test('uses progressive map-derived scenery loads before the full operating area', () => {
    const specs = droneWorldLoadSpecsFor('initial')
    expect(specs.map(spec => spec.stage)).toEqual(['near', 'full'])
    expect(specs[0]?.radiusM).toBeLessThan(specs[1]?.radiusM ?? 0)
    expect(specs.every(spec => spec.zoom === specs[0]?.zoom)).toBe(true)
  })

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

  test('does not re-enqueue the initial scenery load while the initial grid is pending', () => {
    const initial = nextDroneWorldStreamDecision({
      currentCenter: null,
      currentCenterKey: '',
      pendingCenterKey: '',
      desiredCenter: { lon: 10.75, lat: 59.91 },
    })
    expect(initial).not.toBeNull()
    if (!initial) return

    const duplicate = nextDroneWorldStreamDecision({
      currentCenter: null,
      currentCenterKey: '',
      pendingCenterKey: initial.key,
      desiredCenter: { lon: 10.75, lat: 59.91 },
    })

    expect(duplicate).toBeNull()
  })

  test('keeps oversized city GLB tiles out of the interactive startup budget', () => {
    const selected = selectSceneryTilesForBuild([
      sceneryTile({ id: 'dense-center', byteLength: 10_500_000, distanceM: 10 }),
      sceneryTile({ id: 'dense-nearby', byteLength: 8_200_000, distanceM: 20 }),
      sceneryTile({ id: 'bounded-edge', byteLength: 1_200_000, distanceM: 30 }),
    ], sceneryBuildLimitsFor('near'))

    expect(selected.map(tile => tile.id)).toEqual(['bounded-edge'])
  })
})

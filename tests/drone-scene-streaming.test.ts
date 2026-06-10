import { describe, expect, test } from 'bun:test'
import {
  droneWorldLoadSpecsFor,
  nextDroneWorldStreamDecision,
  sceneryBuildLimitsFor,
  selectSceneryTilesForBuild,
  shouldPromoteSceneryStage,
  screenSpaceErrorForSceneryTile,
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
  readonly z?: number
  readonly x?: number
  readonly y?: number
  readonly geometricErrorM?: number
  readonly radiusM?: number
}): DroneSceneryTileAsset => ({
  id: config.id,
  recipeId: 'drone-urban-flight',
  z: config.z ?? 14,
  x: config.x ?? 1,
  y: config.y ?? 1,
  url: `/map/scenery/current/drone-urban-flight/${config.z ?? 14}/${config.x ?? 1}/${config.y ?? 1}.glb`,
  center: { lon: 10.75, lat: 59.91 },
  localOrigin: { x: config.distanceM, z: 0 },
  distanceM: config.distanceM,
  byteLength: config.byteLength,
  bounds: { minLon: 10.74, minLat: 59.9, maxLon: 10.76, maxLat: 59.92 },
  boundingSphere: {
    centerLon: 10.75,
    centerLat: 59.91,
    centerHeightM: 5,
    radiusM: config.radiusM ?? 650,
  },
  lod: {
    zoom: config.z ?? 14,
    geometricErrorM: config.geometricErrorM ?? 8,
    maxScreenSpaceError: 16,
  },
  minHeightM: 0,
  maxHeightM: 24,
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
    expect(specs[0]?.zooms).toEqual([14])
    expect(specs[1]?.zooms).toEqual([12, 13, 14])
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
      sceneryTile({ id: 'dense-center', x: 1, y: 1, byteLength: 10_500_000, distanceM: 10 }),
      sceneryTile({ id: 'dense-nearby', x: 2, y: 1, byteLength: 8_200_000, distanceM: 20 }),
      sceneryTile({ id: 'bounded-edge', x: 3, y: 1, byteLength: 1_200_000, distanceM: 30 }),
    ], sceneryBuildLimitsFor('near'))

    expect(selected.map(tile => tile.id)).toEqual(['bounded-edge'])
  })

  test('loads dense central city tiles in the full scenery stage', () => {
    const selected = selectSceneryTilesForBuild([
      sceneryTile({ id: 'dense-center', x: 1, y: 1, byteLength: 10_500_000, distanceM: 10 }),
      sceneryTile({ id: 'dense-nearby', x: 2, y: 1, byteLength: 8_200_000, distanceM: 20 }),
      sceneryTile({ id: 'bounded-edge', x: 3, y: 1, byteLength: 1_200_000, distanceM: 30 }),
    ], sceneryBuildLimitsFor('full'))

    expect(selected.map(tile => tile.id)).toEqual(['dense-center', 'dense-nearby', 'bounded-edge'])
  })

  test('admits large detailed tiles only after the full scenery stage starts', () => {
    const detailedTile = sceneryTile({ id: 'large-detail', byteLength: 22_000_000, distanceM: 12 })

    expect(selectSceneryTilesForBuild([detailedTile], sceneryBuildLimitsFor('near')).map(tile => tile.id)).toEqual([])
    expect(selectSceneryTilesForBuild([detailedTile], sceneryBuildLimitsFor('full')).map(tile => tile.id)).toEqual(['large-detail'])
  })

  test('computes screen-space error from tile geometric error and distance', () => {
    const near = sceneryTile({ id: 'near-detail', byteLength: 500_000, distanceM: 80, geometricErrorM: 8, radiusM: 20 })
    const far = sceneryTile({ id: 'far-detail', byteLength: 500_000, distanceM: 1_600, geometricErrorM: 8, radiusM: 20 })

    expect(screenSpaceErrorForSceneryTile(near)).toBeGreaterThan(screenSpaceErrorForSceneryTile(far))
  })

  test('keeps overlapping parent and child LOD tiles out of the same loaded set', () => {
    const selected = selectSceneryTilesForBuild([
      sceneryTile({ id: 'coarse-parent', z: 13, x: 4, y: 4, byteLength: 1_100_000, distanceM: 120, geometricErrorM: 16 }),
      sceneryTile({ id: 'detail-child', z: 14, x: 8, y: 8, byteLength: 1_000_000, distanceM: 80, geometricErrorM: 8 }),
      sceneryTile({ id: 'other-detail', z: 14, x: 11, y: 11, byteLength: 1_000_000, distanceM: 100, geometricErrorM: 8 }),
    ], sceneryBuildLimitsFor('full'))

    expect(selected.map(tile => tile.id)).toContain('detail-child')
    expect(selected.map(tile => tile.id)).not.toContain('coarse-parent')
  })

  test('does not replace a loaded full scene with a sparse near scene while streaming', () => {
    expect(shouldPromoteSceneryStage({
      visibleStage: 'full',
      visibleLoadedTileCount: 20,
      visibleCenterKey: 'old-grid',
      candidateStage: 'near',
      candidateLoadedTileCount: 2,
      candidateCenterKey: 'next-grid',
    })).toBe(false)

    expect(shouldPromoteSceneryStage({
      visibleStage: 'full',
      visibleLoadedTileCount: 20,
      visibleCenterKey: 'old-grid',
      candidateStage: 'full',
      candidateLoadedTileCount: 1,
      candidateCenterKey: 'next-grid',
    })).toBe(false)

    expect(shouldPromoteSceneryStage({
      visibleStage: 'full',
      visibleLoadedTileCount: 20,
      visibleCenterKey: 'old-grid',
      candidateStage: 'full',
      candidateLoadedTileCount: 18,
      candidateCenterKey: 'next-grid',
    })).toBe(true)
  })
})

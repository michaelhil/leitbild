import { describe, expect, test } from 'bun:test'
import {
  decodeMapboxElevationM,
  decodeTerrariumElevationM,
  terrainHeightAt,
  type DroneTerrainModel,
} from '../src/ui/drone/drone-terrain.ts'

describe('drone terrain model', () => {
  test('decodes Terrarium and Mapbox RGB elevations', () => {
    expect(decodeTerrariumElevationM(128, 0, 0)).toBe(0)
    expect(decodeTerrariumElevationM(128, 1, 128)).toBeCloseTo(1.5, 5)
    expect(decodeMapboxElevationM(1, 134, 160)).toBe(0)
    expect(decodeMapboxElevationM(1, 134, 170)).toBe(1)
  })

  test('samples DEM grids with bilinear interpolation and clamps outside the grid', () => {
    const model: DroneTerrainModel = {
      kind: 'dem',
      center: { lon: 10.75, lat: 59.91 },
      radiusM: 10,
      gridSize: 3,
      sampleSpacingM: 10,
      heightsM: new Float32Array([
        0, 10, 20,
        10, 20, 30,
        20, 30, 40,
      ]),
      minHeightM: 0,
      maxHeightM: 40,
      source: {
        demEncoding: 'terrarium',
        zoom: 13,
        tileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
      },
    }

    expect(terrainHeightAt(model, 0, 0)).toBe(20)
    expect(terrainHeightAt(model, -5, -5)).toBe(10)
    expect(terrainHeightAt(model, 200, 200)).toBe(40)
    expect(terrainHeightAt({ kind: 'flat', reason: 'test' }, 0, 0)).toBe(0)
  })
})

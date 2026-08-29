import { describe, expect, test } from 'bun:test'
import {
  decodeMapboxElevationM,
  decodeTerrariumElevationM,
  terrainHeightAt,
  terrainSurfaceGeometryFor,
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

  test('creates terrain surface geometry from the decoded DEM grid without changing height scale', () => {
    const model: DroneTerrainModel = {
      kind: 'dem',
      center: { lon: 10.75, lat: 59.91 },
      radiusM: 20,
      gridSize: 3,
      sampleSpacingM: 20,
      heightsM: new Float32Array([
        0, 15, 30,
        20, 35, 50,
        40, 55, 70,
      ]),
      minHeightM: 0,
      maxHeightM: 70,
      source: {
        demEncoding: 'terrarium',
        zoom: 13,
        tileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
      },
    }
    const geometry = terrainSurfaceGeometryFor(model)

    expect(geometry).not.toBeNull()
    expect(geometry?.positions).toHaveLength(27)
    expect(geometry?.indices).toHaveLength(24)
    expect(geometry?.positions[1]).toBe(0)
    expect(geometry?.positions[13]).toBe(35)
    expect(geometry?.positions[25]).toBe(70)
    expect(terrainSurfaceGeometryFor({ kind: 'flat', reason: 'test' })).toBeNull()
  })
})

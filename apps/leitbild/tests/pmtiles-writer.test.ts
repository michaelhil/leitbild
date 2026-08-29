import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { PMTiles, TileType, type Source } from 'pmtiles'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'
import { createPmtilesElevationSamplerFactory } from '../src/map/pmtiles-elevation-sampler.ts'
import { sampleElevationMeters } from '../src/map/elevation-sampler.ts'
import { sceneryTilePointLonLat, type SceneryTile } from '../src/map/scenery.ts'

const sourceFromBytes = (
  bytes: Uint8Array,
): Source => ({
  getKey: (): string => 'memory.pmtiles',
  getBytes: async (
    offset: number,
    length: number,
  ): Promise<{ readonly data: ArrayBuffer }> => ({
    data: bytes.slice(offset, offset + length).buffer,
  }),
})

const uint32Bytes = (
  value: number,
): Uint8Array => {
  const bytes = new Uint8Array(4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, value, false)
  return bytes
}

const asciiBytes = (
  value: string,
): Uint8Array => new TextEncoder().encode(value)

const concatBytes = (
  parts: ReadonlyArray<Uint8Array>,
): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

const pngChunk = (
  type: string,
  data: Uint8Array,
): Uint8Array => concatBytes([
  uint32Bytes(data.length),
  asciiBytes(type),
  data,
  new Uint8Array(4),
])

const rgbTerrariumPng = (): Uint8Array => {
  const ihdr = new Uint8Array([
    ...uint32Bytes(2),
    ...uint32Bytes(2),
    8,
    2,
    0,
    0,
    0,
  ])
  const scanlines = new Uint8Array([
    0, 128, 0, 0, 128, 10, 0,
    0, 128, 20, 0, 128, 30, 0,
  ])
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

describe('PMTiles writer', () => {
  test('writes PNG archives readable by the PMTiles runtime', async () => {
    const tileBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const archiveBytes = writePmtilesArchive({
      tileType: TileType.Png,
      bounds: {
        minLon: 10.7,
        minLat: 59.9,
        maxLon: 10.8,
        maxLat: 60,
      },
      center: {
        lon: 10.75,
        lat: 59.95,
        zoom: 13,
      },
      metadata: {
        id: 'terrain-test',
      },
      tiles: [{
        z: 13,
        x: 4340,
        y: 2375,
        data: tileBytes,
      }],
    })

    const archive = new PMTiles(sourceFromBytes(archiveBytes))
    const header = await archive.getHeader()
    const tile = await archive.getZxy(13, 4340, 2375)

    expect(header.tileType).toBe(TileType.Png)
    expect(header.minZoom).toBe(13)
    expect(header.maxZoom).toBe(13)
    expect(header.numAddressedTiles).toBe(1)
    expect(new Uint8Array(tile?.data ?? new ArrayBuffer(0))).toEqual(tileBytes)
    expect(await archive.getZxy(13, 4340, 2376)).toBeUndefined()
  })

  test('writes rectangular terrain archives with every addressed tile readable', async () => {
    const tiles = []
    for (let x = 4334; x <= 4346; x += 1) {
      for (let y = 2373; y <= 2392; y += 1) {
        tiles.push({
          z: 13,
          x,
          y,
          data: new Uint8Array([x & 0xff, y & 0xff]),
        })
      }
    }

    const archiveBytes = writePmtilesArchive({
      tileType: TileType.Png,
      bounds: {
        minLon: 10.47,
        minLat: 59.7,
        maxLon: 11.03,
        maxLat: 60.13,
      },
      center: {
        lon: 10.75,
        lat: 59.915,
        zoom: 13,
      },
      tiles,
    })

    const archive = new PMTiles(sourceFromBytes(archiveBytes))
    const header = await archive.getHeader()
    let readable = 0
    for (const tile of tiles) {
      const found = await archive.getZxy(tile.z, tile.x, tile.y)
      if (found) readable += 1
    }

    expect(header.numAddressedTiles).toBe(tiles.length)
    expect(readable).toBe(tiles.length)
    expect(await archive.getZxy(13, 4337, 2378)).toBeDefined()
  })

  test('terrain sampler covers buffered scenery geometry outside nominal tile bounds', async () => {
    const scenery: SceneryTile = {
      schemaVersion: 1,
      tileEncoding: 'leitbild-scenery-feature-json-v1',
      recipeId: 'drone-urban-flight',
      sourceTilesetId: 'terrain-test',
      tile: {
        z: 14,
        x: 8676,
        y: 4756,
        extent: 4096,
      },
      features: {
        polygons: [],
        lines: [],
        labels: [{
          id: 'buffered-poi',
          sourceLayer: 'place',
          kind: 'poi',
          className: 'marker',
          label: 'Buffered POI',
          point: [-512, 2048],
        }],
      },
    }
    const terrainTileBytes = rgbTerrariumPng()
    const terrainTiles = []
    for (let x = 4337; x <= 4338; x += 1) {
      for (let y = 2378; y <= 2379; y += 1) {
        terrainTiles.push({ z: 13, x, y, data: terrainTileBytes })
      }
    }
    const archiveBytes = writePmtilesArchive({
      tileType: TileType.Png,
      bounds: {
        minLon: 10.57,
        minLat: 59.95,
        maxLon: 10.72,
        maxLat: 60.02,
      },
      center: {
        lon: 10.64,
        lat: 59.99,
        zoom: 13,
      },
      metadata: {
        demEncoding: 'terrarium',
      },
      tiles: terrainTiles,
    })
    const filePath = join(tmpdir(), `leitbild-terrain-${randomUUID()}.pmtiles`)
    await writeFile(filePath, archiveBytes)
    try {
      const reference = sceneryTilePointLonLat([2048, 2048], scenery.tile)
      const bufferedPoint = sceneryTilePointLonLat([-512, 2048], scenery.tile)
      const factory = await createPmtilesElevationSamplerFactory({
        filePath,
        demEncoding: 'terrarium',
        reference,
      })
      const sampler = await factory.samplerForSceneryTile(scenery)

      expect(bufferedPoint.lon).toBeLessThan(sceneryTilePointLonLat([0, 2048], scenery.tile).lon)
      expect(Number.isFinite(sampleElevationMeters(sampler, bufferedPoint))).toBe(true)
    } finally {
      await rm(filePath, { force: true })
    }
  })

  test('rejects duplicate tiles instead of creating ambiguous archives', () => {
    const tile = {
      z: 13,
      x: 4340,
      y: 2375,
      data: new Uint8Array([1]),
    }

    expect(() => writePmtilesArchive({
      tileType: TileType.Png,
      bounds: {
        minLon: 10.7,
        minLat: 59.9,
        maxLon: 10.8,
        maxLat: 60,
      },
      center: {
        lon: 10.75,
        lat: 59.95,
        zoom: 13,
      },
      tiles: [tile, tile],
    })).toThrow('duplicate tile')
  })
})

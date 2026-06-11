import { describe, expect, test } from 'bun:test'
import { PMTiles, TileType, type Source } from 'pmtiles'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'

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

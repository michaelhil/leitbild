import { stat } from 'node:fs/promises'
import { PMTiles, TileType, type Source } from 'pmtiles'
import type { TerrainDemEncoding } from './dem-encoding.ts'

export type { TerrainDemEncoding } from './dem-encoding.ts'

export interface TerrainPmtilesMetadata {
  readonly filePath: string
  readonly demEncoding: TerrainDemEncoding
  readonly sizeBytes: number
  readonly modifiedAt: string
  readonly minZoom: number
  readonly maxZoom: number
  readonly bounds: readonly [number, number, number, number]
  readonly center: readonly [number, number, number]
  readonly tileType: 'png'
  readonly addressedTileCount: number
}

const createBunFileSource = (filePath: string, key: string): Source => ({
  getKey: (): string => key,
  getBytes: async (
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ readonly data: ArrayBuffer }> => {
    signal?.throwIfAborted()
    const data = await Bun.file(filePath).slice(offset, offset + length).arrayBuffer()
    signal?.throwIfAborted()
    return { data }
  },
})

export const readTerrainPmtilesMetadata = async (config: {
  readonly filePath: string
  readonly demEncoding?: TerrainDemEncoding
}): Promise<TerrainPmtilesMetadata> => {
  const info = await stat(config.filePath)
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`terrain PMTiles artifact is empty or not a file: ${config.filePath}`)
  }

  const key = `${config.filePath}:${info.mtimeMs}:${info.size}`
  const archive = new PMTiles(createBunFileSource(config.filePath, key))
  const header = await archive.getHeader()
  if (header.tileType !== TileType.Png) {
    throw new Error(`terrain PMTiles artifact must contain PNG DEM tiles; found tileType ${header.tileType}`)
  }
  if (header.minZoom > header.maxZoom) {
    throw new Error(`terrain PMTiles artifact has invalid zoom range ${header.minZoom}-${header.maxZoom}`)
  }
  if (!Number.isFinite(header.minLon) || !Number.isFinite(header.minLat) || !Number.isFinite(header.maxLon) || !Number.isFinite(header.maxLat)) {
    throw new Error('terrain PMTiles artifact has invalid bounds')
  }

  return {
    filePath: config.filePath,
    demEncoding: config.demEncoding ?? 'terrarium',
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    tileType: 'png',
    addressedTileCount: header.numAddressedTiles,
  }
}

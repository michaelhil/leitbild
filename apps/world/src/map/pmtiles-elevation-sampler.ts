import { stat } from 'node:fs/promises'
import { PMTiles, TileType, type Source } from 'pmtiles'
import type { ElevationSampler } from './elevation-sampler.ts'
import type { TerrainDemEncoding } from './dem-encoding.ts'
import { decodePngRgbImage, samplePngDemElevationM, type DecodedPngRgbImage } from './png-dem.ts'
import { sceneryTilePointLonLat, type SceneryTile } from './scenery.ts'
import { readTerrainPmtilesMetadata } from './terrain-artifact.ts'

interface TileCoord {
  readonly z: number
  readonly x: number
  readonly y: number
}

interface LoadedDemTile {
  readonly coord: TileCoord
  readonly image: DecodedPngRgbImage
}

export interface ElevationSamplerBounds {
  readonly minLon: number
  readonly minLat: number
  readonly maxLon: number
  readonly maxLat: number
}

export interface PmtilesElevationSamplerFactory {
  readonly kind: 'pmtiles-dem'
  readonly filePath: string
  readonly demEncoding: TerrainDemEncoding
  readonly zoom: number
  readonly reference: {
    readonly lon: number
    readonly lat: number
    readonly absoluteHeightM: number
  }
  readonly samplerForBounds: (bounds: ElevationSamplerBounds) => Promise<ElevationSampler>
  readonly samplerForSceneryTile: (tile: SceneryTile) => Promise<ElevationSampler>
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

const tileCoordFloatFor = (
  lon: number,
  lat: number,
  zoom: number,
): { readonly x: number; readonly y: number } => {
  const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180
  const scale = 2 ** zoom
  return {
    x: (lon + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * scale,
  }
}

const tileForLonLat = (
  lon: number,
  lat: number,
  zoom: number,
): TileCoord => {
  const floating = tileCoordFloatFor(lon, lat, zoom)
  const maxTile = 2 ** zoom - 1
  return {
    z: zoom,
    x: Math.max(0, Math.min(maxTile, Math.floor(floating.x))),
    y: Math.max(0, Math.min(maxTile, Math.floor(floating.y))),
  }
}

const tileKey = (
  coord: TileCoord,
): string =>
  `${coord.z}/${coord.x}/${coord.y}`

const sceneryTileBoundsFor = (
  tile: SceneryTile['tile'],
): ElevationSamplerBounds => {
  const northWest = sceneryTilePointLonLat([0, 0], tile)
  const southEast = sceneryTilePointLonLat([tile.extent, tile.extent], tile)
  return {
    minLon: northWest.lon,
    minLat: southEast.lat,
    maxLon: southEast.lon,
    maxLat: northWest.lat,
  }
}

const includeLonLat = (
  bounds: ElevationSamplerBounds,
  point: ElevationSamplerBounds,
): ElevationSamplerBounds => ({
  minLon: Math.min(bounds.minLon, point.minLon),
  minLat: Math.min(bounds.minLat, point.minLat),
  maxLon: Math.max(bounds.maxLon, point.maxLon),
  maxLat: Math.max(bounds.maxLat, point.maxLat),
})

const boundsForSceneryPoint = (
  point: SceneryTile['features']['labels'][number]['point'],
  tile: SceneryTile['tile'],
): ElevationSamplerBounds => {
  const lonLat = sceneryTilePointLonLat(point, tile)
  return {
    minLon: lonLat.lon,
    minLat: lonLat.lat,
    maxLon: lonLat.lon,
    maxLat: lonLat.lat,
  }
}

const sceneryTileContentBoundsFor = (
  scenery: SceneryTile,
): ElevationSamplerBounds => {
  let bounds = sceneryTileBoundsFor(scenery.tile)
  for (const feature of scenery.features.polygons) {
    for (const ring of feature.rings) {
      for (const point of ring) bounds = includeLonLat(bounds, boundsForSceneryPoint(point, scenery.tile))
    }
  }
  for (const feature of scenery.features.lines) {
    for (const point of feature.path) bounds = includeLonLat(bounds, boundsForSceneryPoint(point, scenery.tile))
  }
  for (const feature of scenery.features.labels) {
    bounds = includeLonLat(bounds, boundsForSceneryPoint(feature.point, scenery.tile))
  }
  return bounds
}

const terrainTileRangeForBounds = (
  bounds: ElevationSamplerBounds,
  zoom: number,
  marginTiles = 0,
): ReadonlyArray<TileCoord> => {
  const northWest = tileForLonLat(bounds.minLon, bounds.maxLat, zoom)
  const southEast = tileForLonLat(bounds.maxLon, bounds.minLat, zoom)
  const maxTile = 2 ** zoom - 1
  const minX = Math.max(0, Math.min(northWest.x, southEast.x) - marginTiles)
  const maxX = Math.min(maxTile, Math.max(northWest.x, southEast.x) + marginTiles)
  const minY = Math.max(0, Math.min(northWest.y, southEast.y) - marginTiles)
  const maxY = Math.min(maxTile, Math.max(northWest.y, southEast.y) + marginTiles)
  const tiles: TileCoord[] = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      tiles.push({ z: zoom, x, y })
    }
  }
  return tiles
}

const sampleLoadedDemTile = (config: {
  readonly tile: LoadedDemTile
  readonly lon: number
  readonly lat: number
  readonly demEncoding: TerrainDemEncoding
}): number => {
  const floating = tileCoordFloatFor(config.lon, config.lat, config.tile.coord.z)
  return samplePngDemElevationM({
    image: config.tile.image,
    x: (floating.x - config.tile.coord.x) * (config.tile.image.width - 1),
    y: (floating.y - config.tile.coord.y) * (config.tile.image.height - 1),
    encoding: config.demEncoding,
  })
}

export const createPmtilesElevationSamplerFactory = async (config: {
  readonly filePath: string
  readonly demEncoding?: TerrainDemEncoding
  readonly reference: {
    readonly lon: number
    readonly lat: number
  }
  readonly zoom?: number
}): Promise<PmtilesElevationSamplerFactory> => {
  const info = await stat(config.filePath)
  const key = `${config.filePath}:${info.mtimeMs}:${info.size}`
  const metadata = await readTerrainPmtilesMetadata({
    filePath: config.filePath,
    ...(config.demEncoding === undefined ? {} : { demEncoding: config.demEncoding }),
  })
  const archive = new PMTiles(createBunFileSource(config.filePath, key))
  const header = await archive.getHeader()
  if (header.tileType !== TileType.Png) throw new Error(`terrain sampler requires PNG PMTiles; found tileType ${header.tileType}`)
  const zoom = Math.max(metadata.minZoom, Math.min(metadata.maxZoom, config.zoom ?? Math.min(13, metadata.maxZoom)))
  const demEncoding = metadata.demEncoding
  const loadedTiles = new Map<string, Promise<LoadedDemTile | null>>()

  const loadTile = async (
    coord: TileCoord,
  ): Promise<LoadedDemTile | null> => {
    const source = await archive.getZxy(coord.z, coord.x, coord.y)
    if (!source) return null
    return {
      coord,
      image: decodePngRgbImage(new Uint8Array(source.data)),
    }
  }

  const loadTileCached = (
    coord: TileCoord,
  ): Promise<LoadedDemTile | null> => {
    const keyForTile = tileKey(coord)
    const existing = loadedTiles.get(keyForTile)
    if (existing) return existing
    const next = loadTile(coord)
    loadedTiles.set(keyForTile, next)
    return next
  }

  const referenceCoord = tileForLonLat(config.reference.lon, config.reference.lat, zoom)
  const referenceTile = await loadTileCached(referenceCoord)
  if (!referenceTile) {
    throw new Error(`terrain sampler cannot read reference DEM tile ${tileKey(referenceCoord)} from ${config.filePath}`)
  }
  const referenceHeightM = sampleLoadedDemTile({
    tile: referenceTile,
    lon: config.reference.lon,
    lat: config.reference.lat,
    demEncoding,
  })

  const samplerForBoundsWithMargin = async (
    bounds: ElevationSamplerBounds,
    marginTiles: number,
  ): Promise<ElevationSampler> => {
    const coords = terrainTileRangeForBounds(bounds, zoom, marginTiles)
    const tiles = new Map<string, LoadedDemTile>()
    await Promise.all(coords.map(async coord => {
      const loaded = await loadTileCached(coord)
      if (loaded) tiles.set(tileKey(coord), loaded)
    }))
    return {
      kind: `pmtiles-dem:${zoom}`,
      heightAtLonLat: point => {
        const coord = tileForLonLat(point.lon, point.lat, zoom)
        const loaded = tiles.get(tileKey(coord))
        if (!loaded) {
          throw new Error(`DEM terrain coverage is missing for ${point.lon.toFixed(6)},${point.lat.toFixed(6)} at ${tileKey(coord)}`)
        }
        return sampleLoadedDemTile({
          tile: loaded,
          lon: point.lon,
          lat: point.lat,
          demEncoding,
        }) - referenceHeightM
      },
    }
  }
  const samplerForBounds = async (
    bounds: ElevationSamplerBounds,
  ): Promise<ElevationSampler> =>
    samplerForBoundsWithMargin(bounds, 0)

  return {
    kind: 'pmtiles-dem',
    filePath: config.filePath,
    demEncoding,
    zoom,
    reference: {
      ...config.reference,
      absoluteHeightM: referenceHeightM,
    },
    samplerForBounds,
    samplerForSceneryTile: async (tile: SceneryTile): Promise<ElevationSampler> =>
      samplerForBoundsWithMargin(sceneryTileContentBoundsFor(tile), 1),
  }
}

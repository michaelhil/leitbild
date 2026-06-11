import type { DroneWorldCenter, DroneWorldTerrainStatus } from './drone-map-world.ts'
import { decodeDemElevationM, type TerrainDemEncoding } from '../../map/dem-encoding.ts'

export {
  decodeMapboxElevationM,
  decodeTerrariumElevationM,
} from '../../map/dem-encoding.ts'

export interface DroneTerrainFlatModel {
  readonly kind: 'flat'
  readonly reason: string
}

export interface DroneTerrainDemModel {
  readonly kind: 'dem'
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly gridSize: number
  readonly sampleSpacingM: number
  readonly heightsM: Float32Array
  readonly minHeightM: number
  readonly maxHeightM: number
  readonly source: {
    readonly demEncoding: TerrainDemEncoding
    readonly zoom: number
    readonly tileTemplate: string
  }
}

export type DroneTerrainModel = DroneTerrainFlatModel | DroneTerrainDemModel

export interface DroneTerrainSurfaceGeometry {
  readonly positions: number[]
  readonly indices: number[]
}

interface TileCoord {
  readonly z: number
  readonly x: number
  readonly y: number
}

interface LoadedTerrainTile {
  readonly coord: TileCoord
  readonly image: ImageData
}

interface TerrainSamplePoint {
  readonly index: number
  readonly lon: number
  readonly lat: number
  readonly coord: TileCoord
}

const metersPerDegreeLat = 111_320
const terrainGridSize = 49

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const lonLatFromLocal = (
  x: number,
  z: number,
  center: DroneWorldCenter,
): { readonly lon: number; readonly lat: number } => ({
  lon: center.lon + x / metersPerDegreeLonAt(center.lat),
  lat: center.lat - z / metersPerDegreeLat,
})

const tileCoordFloatFor = (
  lon: number,
  lat: number,
  zoom: number,
): { readonly x: number; readonly y: number } => {
  const latRad = lat * Math.PI / 180
  const scale = 2 ** zoom
  return {
    x: (lon + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * scale,
  }
}

const tileUrlFor = (
  template: string,
  coord: TileCoord,
): string =>
  template
    .replace('{z}', String(coord.z))
    .replace('{x}', String(coord.x))
    .replace('{y}', String(coord.y))

const imageDataFromBlob = async (
  blob: Blob,
): Promise<ImageData> => {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('browser cannot decode terrain PNG tiles: createImageBitmap is unavailable')
  }
  const image = await createImageBitmap(blob)
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(image.width, image.height)
      : typeof document !== 'undefined'
        ? Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
        : null
    if (!canvas) throw new Error('browser cannot decode terrain PNG tiles: no canvas implementation is available')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('browser cannot decode terrain PNG tiles: 2D canvas context is unavailable')
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, image.width, image.height)
  } finally {
    image.close()
  }
}

const fetchTerrainTile = async (
  coord: TileCoord,
  terrain: Extract<DroneWorldTerrainStatus, { readonly status: 'available' }>,
  signal?: AbortSignal,
): Promise<LoadedTerrainTile | null> => {
  const response = await fetch(tileUrlFor(terrain.tileTemplate, coord), signal ? { signal } : undefined)
  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) throw new Error(`terrain tile ${coord.z}/${coord.x}/${coord.y} failed: ${response.status}`)
  const blob = await response.blob()
  return {
    coord,
    image: await imageDataFromBlob(blob),
  }
}

const tileKey = (coord: TileCoord): string =>
  `${coord.z}/${coord.x}/${coord.y}`

const sampleLoadedTile = (
  tile: LoadedTerrainTile,
  lon: number,
  lat: number,
  encoding: 'terrarium' | 'mapbox',
): number | null => {
  const floating = tileCoordFloatFor(lon, lat, tile.coord.z)
  const localX = (floating.x - tile.coord.x) * tile.image.width
  const localY = (floating.y - tile.coord.y) * tile.image.height
  const x = Math.max(0, Math.min(tile.image.width - 1, Math.floor(localX)))
  const y = Math.max(0, Math.min(tile.image.height - 1, Math.floor(localY)))
  const index = (y * tile.image.width + x) * 4
  const red = tile.image.data[index]
  const green = tile.image.data[index + 1]
  const blue = tile.image.data[index + 2]
  if (red === undefined || green === undefined || blue === undefined) return null
  const elevation = decodeDemElevationM(red, green, blue, encoding)
  return Number.isFinite(elevation) ? elevation : null
}

export const terrainHeightAt = (
  model: DroneTerrainModel,
  x: number,
  z: number,
): number => {
  if (model.kind !== 'dem') return 0
  const half = model.radiusM
  const normalizedX = (Math.max(-half, Math.min(half, x)) + half) / model.sampleSpacingM
  const normalizedZ = (Math.max(-half, Math.min(half, z)) + half) / model.sampleSpacingM
  const x0 = Math.max(0, Math.min(model.gridSize - 1, Math.floor(normalizedX)))
  const z0 = Math.max(0, Math.min(model.gridSize - 1, Math.floor(normalizedZ)))
  const x1 = Math.min(model.gridSize - 1, x0 + 1)
  const z1 = Math.min(model.gridSize - 1, z0 + 1)
  const tx = normalizedX - x0
  const tz = normalizedZ - z0
  const h00 = model.heightsM[z0 * model.gridSize + x0] ?? 0
  const h10 = model.heightsM[z0 * model.gridSize + x1] ?? h00
  const h01 = model.heightsM[z1 * model.gridSize + x0] ?? h00
  const h11 = model.heightsM[z1 * model.gridSize + x1] ?? h01
  const top = h00 + (h10 - h00) * tx
  const bottom = h01 + (h11 - h01) * tx
  return top + (bottom - top) * tz
}

export const loadDroneTerrainModel = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly terrain: DroneWorldTerrainStatus
  readonly signal?: AbortSignal
}): Promise<DroneTerrainModel> => {
  if (config.terrain.status !== 'available') {
    return { kind: 'flat', reason: config.terrain.reason }
  }

  const zoom = Math.min(config.terrain.maxZoom ?? 13, Math.max(config.terrain.minZoom ?? 0, 13))
  const tileSize = config.terrain.tileSize ?? 256
  const rawHeights = new Float32Array(terrainGridSize * terrainGridSize)
  rawHeights.fill(Number.NaN)
  const spacingM = config.radiusM * 2 / (terrainGridSize - 1)

  const tileFor = (lon: number, lat: number): TileCoord => {
    const floating = tileCoordFloatFor(lon, lat, zoom)
    const maxTile = 2 ** zoom - 1
    return {
      z: zoom,
      x: Math.max(0, Math.min(maxTile, Math.floor(floating.x))),
      y: Math.max(0, Math.min(maxTile, Math.floor(floating.y))),
    }
  }

  const samples: TerrainSamplePoint[] = []
  const tilePromises = new Map<string, Promise<LoadedTerrainTile | null>>()
  for (let row = 0; row < terrainGridSize; row += 1) {
    const z = -config.radiusM + row * spacingM
    for (let column = 0; column < terrainGridSize; column += 1) {
      const x = -config.radiusM + column * spacingM
      const lonLat = lonLatFromLocal(x, z, config.center)
      const coord = tileFor(lonLat.lon, lonLat.lat)
      const key = tileKey(coord)
      if (!tilePromises.has(key)) {
        tilePromises.set(key, fetchTerrainTile({ ...coord }, {
          ...config.terrain,
          tileSize,
        }, config.signal))
      }
      samples.push({
        index: row * terrainGridSize + column,
        lon: lonLat.lon,
        lat: lonLat.lat,
        coord,
      })
    }
  }

  const loadedTiles = new Map<string, LoadedTerrainTile | null>()
  await Promise.all([...tilePromises.entries()].map(async ([key, promise]) => {
    loadedTiles.set(key, await promise)
  }))

  for (const sample of samples) {
    const tile = loadedTiles.get(tileKey(sample.coord))
    if (!tile) continue
    const elevation = sampleLoadedTile(tile, sample.lon, sample.lat, config.terrain.demEncoding)
    rawHeights[sample.index] = elevation ?? Number.NaN
  }

  const finiteHeights = [...rawHeights].filter(Number.isFinite)
  if (finiteHeights.length === 0) {
    return { kind: 'flat', reason: 'terrain capability was available but no DEM samples could be decoded' }
  }
  const centerIndex = Math.floor(terrainGridSize / 2) * terrainGridSize + Math.floor(terrainGridSize / 2)
  const referenceHeight = Number.isFinite(rawHeights[centerIndex])
    ? rawHeights[centerIndex]!
    : finiteHeights[Math.floor(finiteHeights.length / 2)] ?? 0
  const heightsM = new Float32Array(rawHeights.length)
  let minHeightM = Number.POSITIVE_INFINITY
  let maxHeightM = Number.NEGATIVE_INFINITY
  for (let index = 0; index < rawHeights.length; index += 1) {
    const raw = rawHeights[index] ?? Number.NaN
    const relative = Number.isFinite(raw) ? Math.max(-450, Math.min(750, raw - referenceHeight)) : 0
    heightsM[index] = relative
    minHeightM = Math.min(minHeightM, relative)
    maxHeightM = Math.max(maxHeightM, relative)
  }

  return {
    kind: 'dem',
    center: config.center,
    radiusM: config.radiusM,
    gridSize: terrainGridSize,
    sampleSpacingM: spacingM,
    heightsM,
    minHeightM,
    maxHeightM,
    source: {
      demEncoding: config.terrain.demEncoding,
      zoom,
      tileTemplate: config.terrain.tileTemplate,
    },
  }
}

export const terrainSurfaceGeometryFor = (
  model: DroneTerrainModel,
): DroneTerrainSurfaceGeometry | null => {
  if (model.kind !== 'dem') return null
  const positions: number[] = []
  const indices: number[] = []
  for (let row = 0; row < model.gridSize; row += 1) {
    const z = -model.radiusM + row * model.sampleSpacingM
    for (let column = 0; column < model.gridSize; column += 1) {
      const x = -model.radiusM + column * model.sampleSpacingM
      const y = model.heightsM[row * model.gridSize + column] ?? 0
      positions.push(x, y, z)
    }
  }
  for (let row = 0; row < model.gridSize - 1; row += 1) {
    for (let column = 0; column < model.gridSize - 1; column += 1) {
      const topLeft = row * model.gridSize + column
      const topRight = topLeft + 1
      const bottomLeft = topLeft + model.gridSize
      const bottomRight = bottomLeft + 1
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight)
    }
  }
  return { positions, indices }
}

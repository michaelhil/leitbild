import {
  cellToBoundary,
  cellToLatLng,
  cellToParent,
  getResolution,
  getHexagonAreaAvg,
  gridDisk,
  isValidCell,
  latLngToCell,
  polygonToCells,
  type H3Index,
} from 'h3-js'
import type { GeoJsonPoint, GeoJsonPolygon } from '../model/index.ts'
import { geoPointFromLonLat } from '../model/index.ts'

export type HexCellId = string & { readonly __brand: 'HexCellId' }
export type HexResolution = number & { readonly __brand: 'HexResolution' }

export interface HexCell {
  readonly id: HexCellId
  readonly resolution: HexResolution
  readonly center: GeoJsonPoint
  readonly boundary: GeoJsonPolygon
}

// H3 geometry is immutable. Bound shared caches independently of runtime state.
const centers = new Map<HexCellId, GeoJsonPoint>()
const boundaries = new Map<HexCellId, GeoJsonPolygon>()
const remember = <T>(cache: Map<HexCellId, T>, id: HexCellId, value: T): T => {
  if (cache.size >= 20_000) cache.delete(cache.keys().next().value!)
  cache.set(id, value)
  return value
}

const assertResolution = (resolution: number): HexResolution => {
  if (!Number.isInteger(resolution) || resolution < 0 || resolution > 15) {
    throw new Error(`H3 resolution must be an integer from 0 through 15, got ${resolution}`)
  }
  return resolution as HexResolution
}

const assertCellId = (cellId: string): HexCellId => {
  if (!isValidCell(cellId)) throw new Error(`invalid H3 cell id: ${cellId}`)
  return cellId as HexCellId
}

const geoJsonRings = (polygon: GeoJsonPolygon): number[][][] => {
  const ring = polygon.coordinates[0]
  if (!ring || ring.length < 4) throw new Error('hex polygon coverage requires a non-empty exterior ring')
  if (polygon.coordinates.flat().length > 4096) throw new Error('hex polygon exceeds 4096 vertices')
  return polygon.coordinates.map((r) => r.map(coordinate => [coordinate[0], coordinate[1]]))
}

/** Conservative bounding-box budget checked before allocating H3 coverage. */
export const hexCoverageEstimate = (polygon: GeoJsonPolygon, resolution: HexResolution): number => {
  const points = geoJsonRings(polygon)[0]!
  const xs = points.map((p) => p[0]!),
    ys = points.map((p) => p[1]!)
  const width = Math.max(...xs) - Math.min(...xs)
  if (width > 180) throw new Error('hex coverage across the antimeridian is not supported')
  const radians = Math.PI / 180
  const areaKm2 =
    6371 ** 2 * width * radians * Math.abs(Math.sin(Math.max(...ys) * radians) - Math.sin(Math.min(...ys) * radians))
  return Math.ceil(areaKm2 / (getHexagonAreaAvg(resolution, 'km2') * 0.15)) + 12
}

export const hexResolution = (resolution: number): HexResolution =>
  assertResolution(resolution)

export const hexCellId = (cellId: string): HexCellId =>
  assertCellId(cellId)

export const hexCellAtPoint = (
  point: GeoJsonPoint,
  resolution: HexResolution,
): HexCellId => assertCellId(latLngToCell(point.coordinates[1], point.coordinates[0], resolution) as H3Index)

export const hexCellResolution = (cellId: HexCellId): HexResolution =>
  assertResolution(getResolution(cellId))

export const hexCellCenter = (cellId: HexCellId): GeoJsonPoint => {
  const cached = centers.get(cellId)
  if (cached) return cached
  const [latitude, longitude] = cellToLatLng(cellId)
  return remember(centers, cellId, geoPointFromLonLat(longitude, latitude))
}

export const hexCellBoundary = (cellId: HexCellId): GeoJsonPolygon => {
  const cached = boundaries.get(cellId)
  if (cached) return cached
  const coordinates = cellToBoundary(cellId, true).map(coordinate => geoPointFromLonLat(coordinate[0], coordinate[1]).coordinates)
  const first = coordinates[0]
  if (!first) throw new Error(`H3 cell ${cellId} produced no boundary coordinates`)
  const last = coordinates[coordinates.length - 1]
  const closed = last && last[0] === first[0] && last[1] === first[1] ? coordinates : [...coordinates, first]
  return remember(boundaries, cellId, { type: 'Polygon', coordinates: [closed] })
}

export const hexCell = (cellId: HexCellId): HexCell => ({
  id: cellId,
  resolution: hexCellResolution(cellId),
  center: hexCellCenter(cellId),
  boundary: hexCellBoundary(cellId),
})

export const hexCellsForPolygon = (
  polygon: GeoJsonPolygon,
  resolution: HexResolution,
  maxCells = 20_000,
): ReadonlyArray<HexCellId> => {
  if (hexCoverageEstimate(polygon, resolution) > maxCells)
    throw new Error(`hex coverage exceeds ${maxCells} cell work budget; reduce area or resolution`)
  const cells = polygonToCells(geoJsonRings(polygon), resolution, true)
  if (cells.length > maxCells) throw new Error('hex coverage exceeded cell budget')
  return cells.map(cellId => assertCellId(cellId))
}

export const hexParentCell = (
  cellId: HexCellId,
  resolution: HexResolution,
): HexCellId => assertCellId(cellToParent(cellId, resolution))

export const hexNeighborCells = (cellId: HexCellId, radius: number): ReadonlyArray<HexCellId> => {
  if (!Number.isInteger(radius) || radius < 0 || radius > 64)
    throw new Error(`hex neighbor radius must be an integer from 0 through 64, got ${radius}`)
  return gridDisk(cellId, radius).map(neighbor => assertCellId(neighbor))
}

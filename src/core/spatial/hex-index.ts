import {
  cellToBoundary,
  cellToLatLng,
  cellToParent,
  getResolution,
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

const geoJsonRing = (polygon: GeoJsonPolygon): number[][] => {
  const ring = polygon.coordinates[0]
  if (!ring || ring.length < 4) throw new Error('hex polygon coverage requires a non-empty exterior ring')
  return ring.map(coordinate => [coordinate[0], coordinate[1]])
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
  const [latitude, longitude] = cellToLatLng(cellId)
  return geoPointFromLonLat(longitude, latitude)
}

export const hexCellBoundary = (cellId: HexCellId): GeoJsonPolygon => {
  const coordinates = cellToBoundary(cellId, true).map(coordinate => geoPointFromLonLat(coordinate[0], coordinate[1]).coordinates)
  const first = coordinates[0]
  if (!first) throw new Error(`H3 cell ${cellId} produced no boundary coordinates`)
  const last = coordinates[coordinates.length - 1]
  const closed = last && last[0] === first[0] && last[1] === first[1] ? coordinates : [...coordinates, first]
  return { type: 'Polygon', coordinates: [closed] }
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
): ReadonlyArray<HexCellId> =>
  polygonToCells(geoJsonRing(polygon), resolution, true).map(cellId => assertCellId(cellId))

export const hexParentCell = (
  cellId: HexCellId,
  resolution: HexResolution,
): HexCellId => assertCellId(cellToParent(cellId, resolution))

export const hexNeighborCells = (
  cellId: HexCellId,
  radius: number,
): ReadonlyArray<HexCellId> => {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`hex neighbor radius must be a non-negative integer, got ${radius}`)
  return gridDisk(cellId, radius).map(neighbor => assertCellId(neighbor))
}

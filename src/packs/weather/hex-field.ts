import type { GeoJsonPoint, GeoJsonPolygon } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'

const metersPerDegreeLatitude = 111_320

interface LocalPoint {
  readonly x: number
  readonly y: number
}

const metersPerDegreeLongitude = (latitudeDeg: number): number =>
  Math.max(1, metersPerDegreeLatitude * Math.cos(latitudeDeg * Math.PI / 180))

const polygonReferenceLatitude = (polygon: GeoJsonPolygon): number => {
  const ring = polygon.coordinates[0]
  if (!ring || ring.length === 0) throw new Error('weather hex field requires a polygon with coordinates')
  return ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length
}

const toLocalPoint = (
  point: readonly [number, number],
  referenceLatitude: number,
): LocalPoint => ({
  x: point[0] * metersPerDegreeLongitude(referenceLatitude),
  y: point[1] * metersPerDegreeLatitude,
})

const fromLocalPoint = (
  point: LocalPoint,
  referenceLatitude: number,
): GeoJsonPoint => geoPointFromLonLat(
  point.x / metersPerDegreeLongitude(referenceLatitude),
  point.y / metersPerDegreeLatitude,
)

const pointInRing = (
  point: LocalPoint,
  ring: ReadonlyArray<LocalPoint>,
): boolean => {
  let inside = false
  for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex++) {
    const current = ring[currentIndex]
    const previous = ring[previousIndex]
    if (!current || !previous) continue
    const intersects = ((current.y > point.y) !== (previous.y > point.y))
      && (point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x)
    if (intersects) inside = !inside
  }
  return inside
}

const pointInPolygon = (
  point: LocalPoint,
  rings: ReadonlyArray<ReadonlyArray<LocalPoint>>,
): boolean => {
  const outerRing = rings[0]
  if (!outerRing || !pointInRing(point, outerRing)) return false
  return !rings.slice(1).some(ring => pointInRing(point, ring))
}

const localBounds = (rings: ReadonlyArray<ReadonlyArray<LocalPoint>>): {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
} => {
  const points = rings.flat()
  if (points.length === 0) throw new Error('weather hex field requires at least one point')
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  })
}

const hexPolygonAt = (
  center: LocalPoint,
  radiusM: number,
  referenceLatitude: number,
): GeoJsonPolygon => {
  const coordinates = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index)
    return fromLocalPoint({
      x: center.x + radiusM * Math.cos(angle),
      y: center.y + radiusM * Math.sin(angle),
    }, referenceLatitude).coordinates
  })
  const first = coordinates[0]
  if (!first) throw new Error('hexagon generation produced no coordinates')
  return {
    type: 'Polygon',
    coordinates: [[...coordinates, first]],
  }
}

export const weatherHexCellPolygons = (
  polygon: GeoJsonPolygon,
  cellSizeM: number,
): ReadonlyArray<GeoJsonPolygon> => {
  if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) throw new Error(`weather cell size must be positive, got ${cellSizeM}`)
  const referenceLatitude = polygonReferenceLatitude(polygon)
  const rings = polygon.coordinates.map(ring => ring.map(position => toLocalPoint(position, referenceLatitude)))
  const bounds = localBounds(rings)
  const radiusM = cellSizeM / 2
  const xStep = radiusM * 1.5
  const yStep = radiusM * Math.sqrt(3)
  const cells: GeoJsonPolygon[] = []
  let column = 0
  for (let x = bounds.minX - radiusM; x <= bounds.maxX + radiusM; x += xStep) {
    const yOffset = column % 2 === 0 ? 0 : yStep / 2
    for (let y = bounds.minY - radiusM + yOffset; y <= bounds.maxY + radiusM; y += yStep) {
      const center = { x, y }
      if (!pointInPolygon(center, rings)) continue
      cells.push(hexPolygonAt(center, radiusM, referenceLatitude))
    }
    column += 1
  }
  return cells
}

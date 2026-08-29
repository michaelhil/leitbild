import type { GeoJsonGeometry, GeoJsonPosition } from './types.ts'

// Hand-rolled point-in-polygon for Polygon and MultiPolygon geometries.
// Even-odd ray casting after Sunday's "PNPOLY". Edge cases handled:
//   - point on a vertex: counts as inside (consistent with most GIS conventions)
//   - point on an edge: counts as inside
//   - polygon with holes: inside outer ring AND not inside any hole
//   - MultiPolygon: inside any constituent polygon
// Numerical tolerance: comparisons are strict; coordinates are degrees (lon/lat) so we
// rely on floating-point arithmetic alone. Callers that need a tolerance band should add
// it explicitly to the query point.
//
// Coordinates throughout are [longitude, latitude].

type Point2D = readonly [number, number]
type Ring = ReadonlyArray<GeoJsonPosition>

const pointEqualsVertex = (p: Point2D, ring: Ring): boolean => {
  for (const vertex of ring) {
    if (vertex[0] === p[0] && vertex[1] === p[1]) return true
  }
  return false
}

const pointOnSegment = (p: Point2D, a: GeoJsonPosition, b: GeoJsonPosition): boolean => {
  const [px, py] = p
  const [ax, ay] = a
  const [bx, by] = b
  // Degenerate (zero-length) segment, common on ring-closing edges where ring[0] === ring[n-1].
  // Treat as "on segment" only if p coincides with the point itself.
  if (ax === bx && ay === by) return px === ax && py === ay
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  if (Math.abs(cross) > 1e-12) return false
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay)
  if (dot < 0) return false
  const lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay)
  if (dot > lenSq) return false
  return true
}

const pointOnRingEdge = (p: Point2D, ring: Ring): boolean => {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ringI = ring[i]
    const ringJ = ring[j]
    if (!ringI || !ringJ) continue
    if (pointOnSegment(p, ringI, ringJ)) return true
  }
  return false
}

const pointInRing = (p: Point2D, ring: Ring): boolean => {
  if (pointEqualsVertex(p, ring)) return true
  if (pointOnRingEdge(p, ring)) return true
  const [x, y] = p
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ringI = ring[i]
    const ringJ = ring[j]
    if (!ringI || !ringJ) continue
    const xi = ringI[0]
    const yi = ringI[1]
    const xj = ringJ[0]
    const yj = ringJ[1]
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

const pointInPolygonRings = (p: Point2D, rings: ReadonlyArray<Ring>): boolean => {
  const outer = rings[0]
  if (!outer || !pointInRing(p, outer)) return false
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i]
    if (hole && pointInRing(p, hole)) {
      // Inside a hole; an edge of the hole still counts as inside the feature.
      if (pointOnRingEdge(p, hole) || pointEqualsVertex(p, hole)) return true
      return false
    }
  }
  return true
}

const pointAsTuple = (point: GeoJsonPosition): Point2D => [point[0], point[1]]

export const pointInPolygon = (point: GeoJsonPosition, geometry: GeoJsonGeometry): boolean => {
  const p = pointAsTuple(point)
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(p, geometry.coordinates)
  }
  if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      if (pointInPolygonRings(p, polygon)) return true
    }
    return false
  }
  return false
}

export const geometryBbox = (geometry: GeoJsonGeometry): [number, number, number, number] | null => {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  const visit = (pos: GeoJsonPosition): void => {
    if (pos[0] < minLon) minLon = pos[0]
    if (pos[0] > maxLon) maxLon = pos[0]
    if (pos[1] < minLat) minLat = pos[1]
    if (pos[1] > maxLat) maxLat = pos[1]
  }
  if (geometry.type === 'Point') {
    visit(geometry.coordinates)
  } else if (geometry.type === 'LineString') {
    for (const c of geometry.coordinates) visit(c)
  } else if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) for (const c of ring) visit(c)
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) for (const c of ring) visit(c)
    }
  }
  if (!Number.isFinite(minLon)) return null
  return [minLon, minLat, maxLon, maxLat]
}

export const pointInBbox = (point: GeoJsonPosition, bbox: readonly [number, number, number, number]): boolean =>
  point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]

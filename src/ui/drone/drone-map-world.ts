import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

export interface DroneWorldCenter {
  readonly lon: number
  readonly lat: number
}

export interface DroneWorldPoint {
  readonly x: number
  readonly z: number
}

export type DroneWorldPolygonKind = 'building' | 'water' | 'landcover' | 'landuse'
export type DroneWorldLineKind = 'road' | 'rail' | 'waterway'
export type DroneWorldPointKind = 'poi'

export interface DroneWorldPolygonFeature {
  readonly id: string
  readonly kind: DroneWorldPolygonKind
  readonly className: string
  readonly rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>
  readonly distanceM: number
  readonly areaM2: number
  readonly heightM?: number
  readonly minHeightM?: number
}

export interface DroneWorldLineFeature {
  readonly id: string
  readonly kind: DroneWorldLineKind
  readonly className: string
  readonly path: ReadonlyArray<DroneWorldPoint>
  readonly widthM: number
  readonly distanceM: number
  readonly lengthM: number
}

export interface DroneWorldPointFeature {
  readonly id: string
  readonly kind: DroneWorldPointKind
  readonly className: string
  readonly label: string
  readonly point: DroneWorldPoint
}

export interface DroneMapWorldSnapshot {
  readonly key: string
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
  readonly tileCount: number
  readonly polygons: ReadonlyArray<DroneWorldPolygonFeature>
  readonly lines: ReadonlyArray<DroneWorldLineFeature>
  readonly points: ReadonlyArray<DroneWorldPointFeature>
}

interface TileCoord {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface GeoJsonGeometry {
  readonly type: string
  readonly coordinates: unknown
}

interface GeoJsonFeature {
  readonly type: 'Feature'
  readonly geometry: GeoJsonGeometry | null
  readonly properties?: Record<string, unknown> | null
}

const metersPerDegreeLat = 111_320
const maxDecodedFeaturesPerLayer = 2_400

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

export const localPointFromLonLat = (
  lon: number,
  lat: number,
  center: DroneWorldCenter,
): DroneWorldPoint => ({
  x: (lon - center.lon) * metersPerDegreeLonAt(center.lat),
  z: -(lat - center.lat) * metersPerDegreeLat,
})

export const horizontalDistanceFromCenterM = (
  point: DroneWorldPoint,
): number =>
  Math.hypot(point.x, point.z)

const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor((lon + 180) / 360 * 2 ** zoom)

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = lat * Math.PI / 180
  return Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * 2 ** zoom)
}

const tileRangeFor = (
  center: DroneWorldCenter,
  radiusM: number,
  zoom: number,
): ReadonlyArray<TileCoord> => {
  const lonDelta = radiusM / metersPerDegreeLonAt(center.lat)
  const latDelta = radiusM / metersPerDegreeLat
  const minX = lonToTileX(center.lon - lonDelta, zoom)
  const maxX = lonToTileX(center.lon + lonDelta, zoom)
  const minY = latToTileY(center.lat + latDelta, zoom)
  const maxY = latToTileY(center.lat - latDelta, zoom)
  const maxTile = 2 ** zoom - 1
  const tiles: TileCoord[] = []
  for (let x = Math.max(0, minX); x <= Math.min(maxTile, maxX); x += 1) {
    for (let y = Math.max(0, minY); y <= Math.min(maxTile, maxY); y += 1) {
      tiles.push({ x, y, z: zoom })
    }
  }
  return tiles
}

const tileKeyFor = (
  center: DroneWorldCenter,
  radiusM: number,
  zoom: number,
): string => {
  const tiles = tileRangeFor(center, radiusM, zoom)
  const first = tiles[0]
  const last = tiles[tiles.length - 1]
  return `${zoom}:${first?.x ?? 0}:${first?.y ?? 0}:${last?.x ?? 0}:${last?.y ?? 0}`
}

const fetchTile = async (
  tile: TileCoord,
  signal: AbortSignal | undefined,
): Promise<VectorTile | null> => {
  const response = await fetch(
    `/map/tiles/current/${tile.z}/${tile.x}/${tile.y}.mvt`,
    signal === undefined ? undefined : { signal },
  )
  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) throw new Error(`vector tile ${tile.z}/${tile.x}/${tile.y} failed: ${response.status}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength === 0) return null
  const pbf = new PbfReader(new Uint8Array(buffer)) as unknown as ConstructorParameters<typeof VectorTile>[0]
  return new VectorTile(pbf)
}

const stringProperty = (
  properties: Record<string, unknown>,
  key: string,
  fallback = '',
): string => {
  const value = properties[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

const numberProperty = (
  properties: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null => {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const pointDistanceM = (
  point: DroneWorldPoint,
): number =>
  Math.hypot(point.x, point.z)

const segmentDistanceToOriginM = (
  start: DroneWorldPoint,
  end: DroneWorldPoint,
): number => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const lengthSq = dx * dx + dz * dz
  if (lengthSq <= Number.EPSILON) return pointDistanceM(start)
  const t = Math.max(0, Math.min(1, -(start.x * dx + start.z * dz) / lengthSq))
  return Math.hypot(start.x + dx * t, start.z + dz * t)
}

const pathDistanceM = (
  path: ReadonlyArray<DroneWorldPoint>,
): number => {
  if (path.length === 0) return Number.POSITIVE_INFINITY
  if (path.length === 1) return pointDistanceM(path[0]!)
  let distance = Number.POSITIVE_INFINITY
  for (let index = 0; index < path.length - 1; index += 1) {
    distance = Math.min(distance, segmentDistanceToOriginM(path[index]!, path[index + 1]!))
  }
  return distance
}

const pathLengthM = (
  path: ReadonlyArray<DroneWorldPoint>,
): number => {
  let length = 0
  for (let index = 0; index < path.length - 1; index += 1) {
    const current = path[index]!
    const next = path[index + 1]!
    length += Math.hypot(next.x - current.x, next.z - current.z)
  }
  return length
}

const ringAreaM2 = (
  ring: ReadonlyArray<DroneWorldPoint>,
): number => {
  let area = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!
    const next = ring[(index + 1) % ring.length]!
    area += current.x * next.z - next.x * current.z
  }
  return area / 2
}

const pointInRing = (
  point: DroneWorldPoint,
  ring: ReadonlyArray<DroneWorldPoint>,
): boolean => {
  let inside = false
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = ring[index]!
    const previous = ring[previousIndex]!
    const intersects = ((current.z > point.z) !== (previous.z > point.z))
      && point.x < (previous.x - current.x) * (point.z - current.z) / (previous.z - current.z + Number.EPSILON) + current.x
    if (intersects) inside = !inside
  }
  return inside
}

const polygonContainsOrigin = (
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
): boolean => {
  const outer = rings[0]
  if (!outer || !pointInRing({ x: 0, z: 0 }, outer)) return false
  return !rings.slice(1).some(ring => pointInRing({ x: 0, z: 0 }, ring))
}

const polygonDistanceM = (
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
): number => {
  if (rings.length === 0) return Number.POSITIVE_INFINITY
  if (polygonContainsOrigin(rings)) return 0
  return Math.min(...rings.map(ring => pathDistanceM(ring)))
}

const polygonAreaM2 = (
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
): number => {
  const outer = rings[0]
  if (!outer) return 0
  const holes = rings.slice(1).reduce((sum, ring) => sum + Math.abs(ringAreaM2(ring)), 0)
  return Math.max(0, Math.abs(ringAreaM2(outer)) - holes)
}

const deterministicBuildingHeight = (
  id: string,
  className: string,
): number => {
  const hash = stableHash(`${id}:${className}`)
  const urbanBoost = className === 'commercial' || className === 'industrial' ? 1.35 : 1
  return (6 + (hash % 11) * 2.6 + ((hash >>> 8) % 7) * 1.4) * urbanBoost
}

const buildingHeightFor = (
  id: string,
  className: string,
  properties: Record<string, unknown>,
): number => {
  const explicit = numberProperty(properties, ['render_height', 'height'])
  if (explicit !== null) return Math.max(2.5, Math.min(220, explicit))
  const levels = numberProperty(properties, ['building:levels', 'levels'])
  if (levels !== null) return Math.max(2.5, Math.min(180, levels * 3.2))
  return deterministicBuildingHeight(id, className)
}

const lineWidthFor = (
  kind: DroneWorldLineKind,
  className: string,
): number => {
  if (kind === 'rail') return 4.8
  if (kind === 'waterway') return className === 'river' ? 14 : 5
  if (className === 'motorway') return 26
  if (className === 'trunk') return 22
  if (className === 'primary') return 18
  if (className === 'secondary') return 13
  if (className === 'tertiary') return 9
  if (className === 'residential' || className === 'unclassified' || className === 'street') return 6.4
  if (className === 'living_street' || className === 'pedestrian') return 4.8
  if (className === 'service') return 5.2
  if (className === 'track') return 3.8
  if (className === 'path' || className === 'footway' || className === 'cycleway') return 2.4
  if (className === 'minor') return 6
  return 4.2
}

const coordinatePair = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = value[0]
  const lat = value[1]
  return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat)
    ? [lon, lat]
    : null
}

const ringFromCoordinates = (
  coordinates: unknown,
  center: DroneWorldCenter,
): ReadonlyArray<DroneWorldPoint> => {
  if (!Array.isArray(coordinates)) return []
  return coordinates.flatMap(item => {
    const pair = coordinatePair(item)
    return pair ? [localPointFromLonLat(pair[0], pair[1], center)] : []
  })
}

const lineFromCoordinates = (
  coordinates: unknown,
  center: DroneWorldCenter,
): ReadonlyArray<DroneWorldPoint> =>
  ringFromCoordinates(coordinates, center)

const polygonRingsFromCoordinates = (
  coordinates: unknown,
  center: DroneWorldCenter,
): ReadonlyArray<ReadonlyArray<DroneWorldPoint>> => {
  if (!Array.isArray(coordinates)) return []
  return coordinates
    .map(ring => ringFromCoordinates(ring, center))
    .filter(ring => ring.length >= 3)
}

const multiPolygonRingsFromCoordinates = (
  coordinates: unknown,
  center: DroneWorldCenter,
): ReadonlyArray<ReadonlyArray<ReadonlyArray<DroneWorldPoint>>> => {
  if (!Array.isArray(coordinates)) return []
  return coordinates
    .map(polygon => polygonRingsFromCoordinates(polygon, center))
    .filter(rings => rings.length > 0)
}

const polygonSortValue = (
  feature: DroneWorldPolygonFeature,
): number => {
  const priority = feature.kind === 'building' ? -2_000 : feature.kind === 'water' ? -1_500 : 0
  return priority + feature.distanceM
}

const lineSortValue = (
  feature: DroneWorldLineFeature,
): number => {
  const priority = feature.kind === 'road' ? -1_500 : feature.kind === 'rail' ? -900 : 0
  return priority + feature.distanceM
}

const roadClassPriority = (
  className: string,
): number => {
  if (className === 'motorway') return 8
  if (className === 'trunk') return 7
  if (className === 'primary') return 6
  if (className === 'secondary') return 5
  if (className === 'tertiary') return 4
  if (className === 'minor' || className === 'residential' || className === 'unclassified' || className === 'street') return 3
  if (className === 'service') return 2
  if (className === 'track' || className === 'path' || className === 'footway' || className === 'cycleway' || className === 'pedestrian') return 1
  return 2
}

const selectWorldPolygons = (
  features: ReadonlyArray<DroneWorldPolygonFeature>,
  radiusM: number,
): ReadonlyArray<DroneWorldPolygonFeature> => {
  const water = features
    .filter(feature => feature.kind === 'water' && feature.distanceM <= radiusM * 1.05)
    .sort((left, right) => left.distanceM - right.distanceM)
    .slice(0, 900)
  const surfaces = features
    .filter(feature => (feature.kind === 'landcover' || feature.kind === 'landuse') && feature.distanceM <= radiusM * 0.98)
    .sort((left, right) => left.distanceM - right.distanceM)
    .slice(0, 1_600)
  const buildings = features
    .filter(feature => feature.kind === 'building' && feature.distanceM <= radiusM)
    .sort((left, right) => {
      const distanceDelta = left.distanceM - right.distanceM
      if (Math.abs(distanceDelta) > 150) return distanceDelta
      return right.areaM2 - left.areaM2
    })
    .slice(0, 5_800)
  return [...water, ...surfaces, ...buildings].sort((a, b) => polygonSortValue(a) - polygonSortValue(b))
}

const selectWorldLines = (
  features: ReadonlyArray<DroneWorldLineFeature>,
  radiusM: number,
): ReadonlyArray<DroneWorldLineFeature> => {
  const waterwayAndRail = features
    .filter(feature => (feature.kind === 'waterway' || feature.kind === 'rail') && feature.distanceM <= radiusM * 1.04)
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
    .slice(0, 1_200)
  const roads = features.filter(feature => feature.kind === 'road' && feature.distanceM <= radiusM * 1.02)
  const majorRoads = roads
    .filter(feature => roadClassPriority(feature.className) >= 5)
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
    .slice(0, 2_800)
  const localRoads = roads
    .filter(feature => roadClassPriority(feature.className) >= 2 && roadClassPriority(feature.className) < 5 && feature.distanceM <= radiusM * 0.98)
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
    .slice(0, 5_800)
  const pathsAndTracks = roads
    .filter(feature => roadClassPriority(feature.className) < 2 && feature.distanceM <= radiusM * 0.72)
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
    .slice(0, 1_800)
  return [...waterwayAndRail, ...majorRoads, ...localRoads, ...pathsAndTracks]
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
}

const selectWorldPoints = (
  points: ReadonlyArray<DroneWorldPointFeature>,
): ReadonlyArray<DroneWorldPointFeature> =>
  [...points]
    .sort((left, right) => horizontalDistanceFromCenterM(left.point) - horizontalDistanceFromCenterM(right.point))
    .slice(0, 160)

const decodePolygonFeature = (
  id: string,
  kind: DroneWorldPolygonKind,
  className: string,
  geometry: GeoJsonGeometry,
  properties: Record<string, unknown>,
  center: DroneWorldCenter,
  radiusM: number,
): ReadonlyArray<DroneWorldPolygonFeature> => {
  const polygons = geometry.type === 'Polygon'
    ? [polygonRingsFromCoordinates(geometry.coordinates, center)]
    : geometry.type === 'MultiPolygon'
      ? multiPolygonRingsFromCoordinates(geometry.coordinates, center)
      : []
  return polygons.flatMap((rings, index) => {
    const firstRing = rings[0] ?? []
    const distanceM = polygonDistanceM(rings)
    if (firstRing.length < 3 || distanceM > radiusM * 1.08) return []
    const areaM2 = polygonAreaM2(rings)
    if (areaM2 < 3) return []
    const heightM = kind === 'building' ? buildingHeightFor(id, className, properties) : undefined
    const minHeightM = kind === 'building'
      ? numberProperty(properties, ['render_min_height', 'min_height']) ?? undefined
      : undefined
    return [{
      id: `${id}:${index}`,
      kind,
      className,
      rings,
      distanceM,
      areaM2,
      ...(heightM === undefined ? {} : { heightM }),
      ...(minHeightM === undefined ? {} : { minHeightM }),
    }]
  })
}

const decodeLineFeature = (
  id: string,
  kind: DroneWorldLineKind,
  className: string,
  geometry: GeoJsonGeometry,
  center: DroneWorldCenter,
  radiusM: number,
): ReadonlyArray<DroneWorldLineFeature> => {
  const paths = geometry.type === 'LineString'
    ? [lineFromCoordinates(geometry.coordinates, center)]
    : geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)
      ? geometry.coordinates.map(line => lineFromCoordinates(line, center))
      : []
  return paths.flatMap((path, index) => {
    if (path.length < 2) return []
    const distanceM = pathDistanceM(path)
    if (distanceM > radiusM * 1.06) return []
    const lengthM = pathLengthM(path)
    if (lengthM < 0.8) return []
    return [{
      id: `${id}:${index}`,
      kind,
      className,
      path,
      widthM: lineWidthFor(kind, className),
      distanceM,
      lengthM,
    }]
  })
}

const decodePointFeature = (
  id: string,
  className: string,
  label: string,
  geometry: GeoJsonGeometry,
  center: DroneWorldCenter,
  radiusM: number,
): ReadonlyArray<DroneWorldPointFeature> => {
  const point = coordinatePair(geometry.coordinates)
  if (!point) return []
  const local = localPointFromLonLat(point[0], point[1], center)
  if (horizontalDistanceFromCenterM(local) > radiusM) return []
  return [{ id, kind: 'poi', className, label, point: local }]
}

const decodeLayer = (
  tile: VectorTile,
  tileCoord: TileCoord,
  layerId: string,
  center: DroneWorldCenter,
  radiusM: number,
): {
  readonly polygons: ReadonlyArray<DroneWorldPolygonFeature>
  readonly lines: ReadonlyArray<DroneWorldLineFeature>
  readonly points: ReadonlyArray<DroneWorldPointFeature>
} => {
  const layer = tile.layers[layerId]
  if (!layer) return { polygons: [], lines: [], points: [] }
  const polygons: DroneWorldPolygonFeature[] = []
  const lines: DroneWorldLineFeature[] = []
  const points: DroneWorldPointFeature[] = []
  const featureCount = Math.min(layer.length, maxDecodedFeaturesPerLayer)
  for (let index = 0; index < featureCount; index += 1) {
    const vectorFeature = layer.feature(index)
    const feature = vectorFeature.toGeoJSON(tileCoord.x, tileCoord.y, tileCoord.z) as GeoJsonFeature
    if (!feature.geometry) continue
    const properties = feature.properties ?? {}
    const className = stringProperty(properties, 'class', stringProperty(properties, 'type', layerId))
    const id = `${tileCoord.z}/${tileCoord.x}/${tileCoord.y}:${layerId}:${vectorFeature.id ?? index}`
    if (layerId === 'building') {
      polygons.push(...decodePolygonFeature(id, 'building', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'water') {
      polygons.push(...decodePolygonFeature(id, 'water', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'landcover') {
      polygons.push(...decodePolygonFeature(id, 'landcover', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'landuse') {
      polygons.push(...decodePolygonFeature(id, 'landuse', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'waterway') {
      lines.push(...decodeLineFeature(id, 'waterway', className, feature.geometry, center, radiusM))
    } else if (layerId === 'transportation') {
      const kind = className === 'rail' ? 'rail' : 'road'
      lines.push(...decodeLineFeature(id, kind, className, feature.geometry, center, radiusM))
    } else if (layerId === 'poi') {
      const label = stringProperty(properties, 'name', className)
      points.push(...decodePointFeature(id, className, label, feature.geometry, center, radiusM))
    }
  }
  return { polygons, lines, points }
}

const maxWorldZoom = 14

export const loadDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
  readonly signal?: AbortSignal
}): Promise<DroneMapWorldSnapshot> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = Math.min(maxWorldZoom, config.zoom ?? maxWorldZoom)
  const tiles = tileRangeFor(config.center, radiusM, zoom)
  const decoded = await Promise.all(tiles.map(async tile => {
    const vectorTile = await fetchTile(tile, config.signal)
    if (!vectorTile) return { polygons: [], lines: [], points: [] }
    const layers = ['landcover', 'landuse', 'water', 'waterway', 'transportation', 'building', 'poi']
    const layerFeatures = layers.map(layer => decodeLayer(vectorTile, tile, layer, config.center, radiusM))
    return {
      polygons: layerFeatures.flatMap(layer => layer.polygons),
      lines: layerFeatures.flatMap(layer => layer.lines),
      points: layerFeatures.flatMap(layer => layer.points),
    }
  }))
  const polygons = selectWorldPolygons(decoded.flatMap(item => item.polygons), radiusM)
  const lines = selectWorldLines(decoded.flatMap(item => item.lines), radiusM)
  const points = selectWorldPoints(decoded.flatMap(item => item.points))
  return {
    key: tileKeyFor(config.center, radiusM, zoom),
    center: config.center,
    radiusM,
    zoom,
    tileCount: tiles.length,
    polygons,
    lines,
    points,
  }
}

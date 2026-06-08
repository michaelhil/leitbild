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

export type DroneWorldPolygonKind = 'aeroway' | 'building' | 'water' | 'landcover' | 'landuse'
export type DroneWorldLineKind = 'aeroway' | 'road' | 'rail' | 'waterway'
export type DroneWorldPointKind = 'place' | 'poi' | 'road_label'

export interface DroneWorldPolygonFeature {
  readonly id: string
  readonly kind: DroneWorldPolygonKind
  readonly className: string
  readonly name?: string
  readonly subclass?: string
  readonly rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>
  readonly distanceM: number
  readonly areaM2: number
  readonly heightM?: number
  readonly minHeightM?: number
}

export interface DroneWorldLineFeature {
  readonly id: string
  readonly sourceRef?: string
  readonly kind: DroneWorldLineKind
  readonly className: string
  readonly subclass?: string
  readonly name?: string
  readonly surface?: string
  readonly brunnel?: string
  readonly layer?: number
  readonly service?: string
  readonly access?: string
  readonly maxspeedKph?: number
  readonly oneway?: boolean
  readonly isBridge: boolean
  readonly isTunnel: boolean
  readonly path: ReadonlyArray<DroneWorldPoint>
  readonly widthM: number
  readonly verticalOffsetM: number
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

export type DroneWorldTerrainStatus =
  | {
      readonly status: 'available'
      readonly demEncoding: 'terrarium' | 'mapbox'
      readonly tileTemplate: string
      readonly tileJsonUrl: string
      readonly minZoom?: number
      readonly maxZoom?: number
      readonly tileSize?: 256 | 512
      readonly path?: string
    }
  | {
      readonly status: 'unavailable'
      readonly reason: string
      readonly path?: string
    }
  | {
      readonly status: 'unknown'
      readonly reason: string
    }

export interface DroneWorldFeatureCount {
  readonly polygons: number
  readonly lines: number
  readonly points: number
}

export interface DroneWorldSceneryCoverage {
  readonly decoded: DroneWorldFeatureCount
  readonly selected: DroneWorldFeatureCount & {
    readonly buildings: number
    readonly roads: number
    readonly waterPolygons: number
    readonly waterways: number
    readonly vegetationPolygons: number
    readonly roadLabels: number
    readonly pois: number
  }
  readonly lineFragmentsMerged: number
  readonly notes: ReadonlyArray<string>
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
  readonly coverage: DroneWorldSceneryCoverage
}

export interface DroneMapWorldCacheStats {
  readonly size: number
  readonly hits: number
  readonly misses: number
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

const maxDecodedFeaturesForLayer = (
  layerId: string,
): number => {
  if (layerId === 'building') return 14_000
  if (layerId === 'transportation') return 12_000
  if (layerId === 'transportation_name') return 8_000
  if (layerId === 'landcover' || layerId === 'landuse') return 8_000
  if (layerId === 'poi' || layerId === 'place') return 5_000
  return 6_000
}

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

const optionalStringProperty = (
  properties: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = properties[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const booleanLikeProperty = (
  properties: Record<string, unknown>,
  key: string,
): boolean => {
  const value = properties[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return typeof value === 'string' && ['yes', 'true', '1'].includes(value.toLowerCase())
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

const booleanPropertyValue = (
  properties: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean | undefined => {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
    if (typeof value === 'string' && value.length > 0) {
      const normalized = value.toLowerCase()
      if (['yes', 'true', '1'].includes(normalized)) return true
      if (['no', 'false', '0'].includes(normalized)) return false
    }
  }
  return undefined
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
  if (kind === 'aeroway') {
    if (className === 'runway') return 42
    if (className === 'taxiway') return 14
    return 8
  }
  if (kind === 'rail') return 4.8
  if (kind === 'waterway') return className === 'river' ? 14 : 5
  if (className === 'motorway' || className === 'motorway_link') return 26
  if (className === 'trunk' || className === 'trunk_link') return 22
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

const lineVerticalOffsetM = (config: {
  readonly isBridge: boolean
  readonly isTunnel: boolean
  readonly layer?: number
}): number => {
  if (config.isBridge) return 3.2 + Math.max(0, config.layer ?? 0) * 2
  if (config.isTunnel) return -1.4
  return 0
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
  const priority = feature.kind === 'building'
    ? -2_000
    : feature.kind === 'water'
      ? -1_500
      : feature.kind === 'aeroway'
        ? -1_200
        : 0
  return priority + feature.distanceM
}

const lineSortValue = (
  feature: DroneWorldLineFeature,
): number => {
  const priority = feature.kind === 'road'
    ? -1_500
    : feature.kind === 'aeroway'
      ? -1_100
      : feature.kind === 'rail'
        ? -900
        : 0
  return priority + feature.distanceM
}

const roadClassPriority = (
  className: string,
): number => {
  if (className === 'motorway' || className === 'motorway_link') return 8
  if (className === 'trunk' || className === 'trunk_link') return 7
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
    .filter(feature => (feature.kind === 'aeroway' || feature.kind === 'landcover' || feature.kind === 'landuse') && feature.distanceM <= radiusM * 0.98)
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
  const waterwayRailAndAeroway = features
    .filter(feature => (feature.kind === 'waterway' || feature.kind === 'rail' || feature.kind === 'aeroway') && feature.distanceM <= radiusM * 1.04)
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
  return [...waterwayRailAndAeroway, ...majorRoads, ...localRoads, ...pathsAndTracks]
    .sort((left, right) => lineSortValue(left) - lineSortValue(right))
}

const pointKindPriority = (
  feature: DroneWorldPointFeature,
): number => {
  if (feature.kind === 'poi') return 0
  if (feature.kind === 'road_label') return 1
  return 2
}

const selectWorldPoints = (
  points: ReadonlyArray<DroneWorldPointFeature>,
): ReadonlyArray<DroneWorldPointFeature> =>
  [...points]
    .sort((left, right) => {
      const priorityDelta = pointKindPriority(left) - pointKindPriority(right)
      if (priorityDelta !== 0) return priorityDelta
      return horizontalDistanceFromCenterM(left.point) - horizontalDistanceFromCenterM(right.point)
    })
    .slice(0, 240)

const lineMergeEndpointToleranceM = 2.2

const endpointDistanceM = (
  left: DroneWorldPoint | undefined,
  right: DroneWorldPoint | undefined,
): number =>
  left && right ? Math.hypot(left.x - right.x, left.z - right.z) : Number.POSITIVE_INFINITY

const lineMergeKeyFor = (
  feature: DroneWorldLineFeature,
): string | null => {
  if (feature.sourceRef) return `source:${feature.sourceRef}`
  const canMergeNamedRoad = feature.kind === 'road'
    && feature.name !== undefined
    && feature.name.length > 0
    && roadClassPriority(feature.className) >= 4
  if (!canMergeNamedRoad) return null
  return [
    'named-road',
    feature.className,
    feature.subclass ?? '',
    feature.name ?? '',
    feature.brunnel ?? '',
    feature.layer ?? '',
    feature.service ?? '',
    feature.access ?? '',
    feature.oneway ?? '',
    feature.widthM,
    feature.verticalOffsetM,
  ].join(':')
}

const withoutDuplicateJoinPoint = (
  path: ReadonlyArray<DroneWorldPoint>,
): ReadonlyArray<DroneWorldPoint> =>
  path.slice(1)

const joinedPath = (
  left: ReadonlyArray<DroneWorldPoint>,
  right: ReadonlyArray<DroneWorldPoint>,
): ReadonlyArray<DroneWorldPoint> | null => {
  const leftStart = left[0]
  const leftEnd = left[left.length - 1]
  const rightStart = right[0]
  const rightEnd = right[right.length - 1]
  const candidates: ReadonlyArray<{
    readonly distanceM: number
    readonly path: ReadonlyArray<DroneWorldPoint>
  }> = [
    { distanceM: endpointDistanceM(leftEnd, rightStart), path: [...left, ...withoutDuplicateJoinPoint(right)] },
    { distanceM: endpointDistanceM(leftStart, rightEnd), path: [...right, ...withoutDuplicateJoinPoint(left)] },
    { distanceM: endpointDistanceM(leftEnd, rightEnd), path: [...left, ...withoutDuplicateJoinPoint([...right].reverse())] },
    { distanceM: endpointDistanceM(leftStart, rightStart), path: [[...right].reverse(), withoutDuplicateJoinPoint(left)].flat() },
  ].sort((a, b) => a.distanceM - b.distanceM)
  const best = candidates[0]
  return best && best.distanceM <= lineMergeEndpointToleranceM ? best.path : null
}

const mergeLineRun = (
  first: DroneWorldLineFeature,
  second: DroneWorldLineFeature,
  path: ReadonlyArray<DroneWorldPoint>,
): DroneWorldLineFeature => ({
  ...first,
  id: `${first.id}+${second.id}`,
  path,
  distanceM: pathDistanceM(path),
  lengthM: pathLengthM(path),
})

const mergeLineGroup = (
  group: ReadonlyArray<DroneWorldLineFeature>,
): ReadonlyArray<DroneWorldLineFeature> => {
  const runs = [...group].sort((left, right) => left.id.localeCompare(right.id))
  let changed = true
  while (changed) {
    changed = false
    for (let leftIndex = 0; leftIndex < runs.length && !changed; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < runs.length; rightIndex += 1) {
        const mergedPath = joinedPath(runs[leftIndex]!.path, runs[rightIndex]!.path)
        if (!mergedPath) continue
        const merged = mergeLineRun(runs[leftIndex]!, runs[rightIndex]!, mergedPath)
        runs.splice(rightIndex, 1)
        runs[leftIndex] = merged
        changed = true
        break
      }
    }
  }
  return runs
}

export const mergeDroneWorldLinesForScenery = (
  features: ReadonlyArray<DroneWorldLineFeature>,
): ReadonlyArray<DroneWorldLineFeature> => {
  const groups = new Map<string, DroneWorldLineFeature[]>()
  const passthrough: DroneWorldLineFeature[] = []
  for (const feature of features) {
    const key = lineMergeKeyFor(feature)
    if (!key) {
      passthrough.push(feature)
      continue
    }
    const existing = groups.get(key)
    if (existing) {
      existing.push(feature)
      continue
    }
    groups.set(key, [feature])
  }
  const merged = [...passthrough]
  for (const group of groups.values()) {
    merged.push(...(group.length <= 1 ? group : mergeLineGroup(group)))
  }
  return merged.sort((left, right) => lineSortValue(left) - lineSortValue(right))
}

const sceneryCoverageNotes = (config: {
  readonly selectedPolygons: ReadonlyArray<DroneWorldPolygonFeature>
  readonly selectedLines: ReadonlyArray<DroneWorldLineFeature>
  readonly selectedPoints: ReadonlyArray<DroneWorldPointFeature>
  readonly decoded: DroneWorldFeatureCount
  readonly mergedLineCount: number
}): ReadonlyArray<string> => {
  const notes: string[] = []
  if (!config.selectedPolygons.some(feature => feature.kind === 'building')) notes.push('No selected building footprints; 3D buildings are source-data limited for this world.')
  if (!config.selectedLines.some(feature => feature.kind === 'road')) notes.push('No selected roads; ground transport scenery is source-data limited for this world.')
  if (!config.selectedPolygons.some(feature => feature.kind === 'water') && !config.selectedLines.some(feature => feature.kind === 'waterway')) {
    notes.push('No selected water polygons or waterways; marine and river scenery is source-data limited for this world.')
  }
  if (!config.selectedPolygons.some(feature => feature.kind === 'landcover' || feature.kind === 'landuse')) {
    notes.push('No selected landcover or landuse polygons; vegetation and non-city variation are source-data limited for this world.')
  }
  if (config.decoded.lines > config.mergedLineCount) {
    notes.push(`Merged ${config.decoded.lines - config.mergedLineCount} source transport fragments before rendering.`)
  }
  return notes
}

const sceneryCoverageFor = (config: {
  readonly decoded: {
    readonly polygons: ReadonlyArray<DroneWorldPolygonFeature>
    readonly lines: ReadonlyArray<DroneWorldLineFeature>
    readonly points: ReadonlyArray<DroneWorldPointFeature>
  }
  readonly mergedLines: ReadonlyArray<DroneWorldLineFeature>
  readonly selectedPolygons: ReadonlyArray<DroneWorldPolygonFeature>
  readonly selectedLines: ReadonlyArray<DroneWorldLineFeature>
  readonly selectedPoints: ReadonlyArray<DroneWorldPointFeature>
}): DroneWorldSceneryCoverage => {
  const selected = {
    polygons: config.selectedPolygons.length,
    lines: config.selectedLines.length,
    points: config.selectedPoints.length,
    buildings: config.selectedPolygons.filter(feature => feature.kind === 'building').length,
    roads: config.selectedLines.filter(feature => feature.kind === 'road').length,
    waterPolygons: config.selectedPolygons.filter(feature => feature.kind === 'water').length,
    waterways: config.selectedLines.filter(feature => feature.kind === 'waterway').length,
    vegetationPolygons: config.selectedPolygons.filter(feature => feature.kind === 'landcover' || feature.kind === 'landuse').length,
    roadLabels: config.selectedPoints.filter(feature => feature.kind === 'road_label').length,
    pois: config.selectedPoints.filter(feature => feature.kind === 'poi').length,
  }
  const decoded = {
    polygons: config.decoded.polygons.length,
    lines: config.decoded.lines.length,
    points: config.decoded.points.length,
  }
  return {
    decoded,
    selected,
    lineFragmentsMerged: Math.max(0, decoded.lines - config.mergedLines.length),
    notes: sceneryCoverageNotes({
      selectedPolygons: config.selectedPolygons,
      selectedLines: config.selectedLines,
      selectedPoints: config.selectedPoints,
      decoded,
      mergedLineCount: config.mergedLines.length,
    }),
  }
}

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
    const name = optionalStringProperty(properties, 'name')
    const subclass = optionalStringProperty(properties, 'subclass')
    return [{
      id: `${id}:${index}`,
      kind,
      className,
      ...(name === undefined ? {} : { name }),
      ...(subclass === undefined ? {} : { subclass }),
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
  sourceRef: string | undefined,
  kind: DroneWorldLineKind,
  className: string,
  geometry: GeoJsonGeometry,
  properties: Record<string, unknown>,
  center: DroneWorldCenter,
  radiusM: number,
): ReadonlyArray<DroneWorldLineFeature> => {
  const brunnel = optionalStringProperty(properties, 'brunnel')
  const isBridge = brunnel === 'bridge' || booleanLikeProperty(properties, 'bridge')
  const isTunnel = brunnel === 'tunnel' || booleanLikeProperty(properties, 'tunnel')
  const layer = numberProperty(properties, ['layer']) ?? undefined
  const surface = optionalStringProperty(properties, 'surface')
  const name = optionalStringProperty(properties, 'name')
  const subclass = optionalStringProperty(properties, 'subclass')
  const service = optionalStringProperty(properties, 'service')
  const access = optionalStringProperty(properties, 'access')
  const maxspeedKph = numberProperty(properties, ['maxspeed']) ?? undefined
  const oneway = booleanPropertyValue(properties, ['oneway'])
  const verticalOffsetM = lineVerticalOffsetM({ isBridge, isTunnel, ...(layer === undefined ? {} : { layer }) })
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
      ...(sourceRef === undefined ? {} : { sourceRef }),
      kind,
      className,
      ...(subclass === undefined ? {} : { subclass }),
      ...(name === undefined ? {} : { name }),
      ...(surface === undefined ? {} : { surface }),
      ...(brunnel === undefined ? {} : { brunnel }),
      ...(layer === undefined ? {} : { layer }),
      ...(service === undefined ? {} : { service }),
      ...(access === undefined ? {} : { access }),
      ...(maxspeedKph === undefined ? {} : { maxspeedKph }),
      ...(oneway === undefined ? {} : { oneway }),
      isBridge,
      isTunnel,
      path,
      widthM: lineWidthFor(kind, className),
      verticalOffsetM,
      distanceM,
      lengthM,
    }]
  })
}

const pathLabelPoint = (
  path: ReadonlyArray<DroneWorldPoint>,
): DroneWorldPoint | null => {
  if (path.length === 0) return null
  if (path.length === 1) return path[0] ?? null
  const total = pathLengthM(path)
  if (total <= Number.EPSILON) return path[Math.floor(path.length / 2)] ?? null
  const target = total / 2
  let travelled = 0
  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index]!
    const end = path[index + 1]!
    const length = Math.hypot(end.x - start.x, end.z - start.z)
    if (travelled + length >= target) {
      const t = (target - travelled) / Math.max(0.001, length)
      return {
        x: start.x + (end.x - start.x) * t,
        z: start.z + (end.z - start.z) * t,
      }
    }
    travelled += length
  }
  return path[path.length - 1] ?? null
}

const decodeLineLabelFeature = (
  id: string,
  kind: DroneWorldPointKind,
  className: string,
  label: string,
  geometry: GeoJsonGeometry,
  center: DroneWorldCenter,
  radiusM: number,
): ReadonlyArray<DroneWorldPointFeature> => {
  const paths = geometry.type === 'LineString'
    ? [lineFromCoordinates(geometry.coordinates, center)]
    : geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)
      ? geometry.coordinates.map(line => lineFromCoordinates(line, center))
      : []
  return paths.flatMap((path, index) => {
    if (path.length < 2 || pathLengthM(path) < 20) return []
    const point = pathLabelPoint(path)
    if (!point || horizontalDistanceFromCenterM(point) > radiusM) return []
    return [{ id: `${id}:${index}`, kind, className, label, point }]
  })
}

const decodePointFeature = (
  id: string,
  kind: DroneWorldPointKind,
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
  return [{ id, kind, className, label, point: local }]
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
  const featureCount = Math.min(layer.length, maxDecodedFeaturesForLayer(layerId))
  for (let index = 0; index < featureCount; index += 1) {
    const vectorFeature = layer.feature(index)
    const feature = vectorFeature.toGeoJSON(tileCoord.x, tileCoord.y, tileCoord.z) as GeoJsonFeature
    if (!feature.geometry) continue
    const properties = feature.properties ?? {}
    const className = stringProperty(properties, 'class', stringProperty(properties, 'type', layerId))
    const id = `${tileCoord.z}/${tileCoord.x}/${tileCoord.y}:${layerId}:${vectorFeature.id ?? index}`
    const sourceRef = vectorFeature.id === undefined ? undefined : `${layerId}:${vectorFeature.id}`
    if (layerId === 'building') {
      polygons.push(...decodePolygonFeature(id, 'building', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'aeroway') {
      polygons.push(...decodePolygonFeature(id, 'aeroway', className, feature.geometry, properties, center, radiusM))
      lines.push(...decodeLineFeature(id, sourceRef, 'aeroway', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'water') {
      polygons.push(...decodePolygonFeature(id, 'water', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'landcover') {
      polygons.push(...decodePolygonFeature(id, 'landcover', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'landuse') {
      polygons.push(...decodePolygonFeature(id, 'landuse', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'waterway') {
      lines.push(...decodeLineFeature(id, sourceRef, 'waterway', className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'transportation') {
      const kind = className === 'rail' ? 'rail' : 'road'
      lines.push(...decodeLineFeature(id, sourceRef, kind, className, feature.geometry, properties, center, radiusM))
    } else if (layerId === 'transportation_name') {
      const label = optionalStringProperty(properties, 'name')
      if (label) points.push(...decodeLineLabelFeature(id, 'road_label', className, label, feature.geometry, center, radiusM))
    } else if (layerId === 'poi') {
      const label = stringProperty(properties, 'name', className)
      points.push(...decodePointFeature(id, 'poi', className, label, feature.geometry, center, radiusM))
    } else if (layerId === 'place') {
      const label = stringProperty(properties, 'name', className)
      points.push(...decodePointFeature(id, 'place', className, label, feature.geometry, center, radiusM))
    }
  }
  return { polygons, lines, points }
}

const maxWorldZoom = 14
const maxCachedWorldSnapshots = 6
const tileDecodeConcurrency = 14

let worldCacheHits = 0
let worldCacheMisses = 0

const cachedWorldSnapshots = new Map<string, Promise<DroneMapWorldSnapshot>>()

const mapWithConcurrency = async <Input, Output>(
  items: ReadonlyArray<Input>,
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<ReadonlyArray<Output>> => {
  const results: Output[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!, index)
    }
  }
  const workers: Promise<void>[] = []
  for (let index = 0; index < workerCount; index += 1) workers.push(runWorker())
  await Promise.all(workers)
  return results
}

const recordValue = (
  value: unknown,
): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null

const stringValue = (
  value: unknown,
): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const finiteNumberValue = (
  value: unknown,
): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const terrainStatusFromManifest = (
  value: unknown,
): DroneWorldTerrainStatus => {
  const manifest = recordValue(value)
  const tilesets = Array.isArray(manifest?.tilesets) ? manifest.tilesets : null
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const terrain = tilesets
    .map(recordValue)
    .find(tileset => tileset?.kind === 'terrain')
  if (!terrain) return { status: 'unavailable', reason: 'terrain capability is not advertised' }

  const availability = recordValue(terrain.availability)
  const artifact = recordValue(terrain.artifact)
  const availabilityStatus = stringValue(availability?.status)
  const path = stringValue(availability?.path)
  if (availabilityStatus === 'available') {
    const demEncoding = stringValue(artifact?.demEncoding)
    const tileTemplate = stringValue(artifact?.currentTileTemplate)
    const tileJsonUrl = stringValue(artifact?.tileJsonUrl)
    const minZoom = finiteNumberValue(artifact?.minZoom)
    const maxZoom = finiteNumberValue(artifact?.maxZoom)
    const tileSize = finiteNumberValue(artifact?.tileSize)
    if ((demEncoding !== 'terrarium' && demEncoding !== 'mapbox') || !tileTemplate || !tileJsonUrl) {
      return { status: 'unknown', reason: 'terrain capability is available but artifact metadata is incomplete' }
    }
    const encoding: 'terrarium' | 'mapbox' = demEncoding
    const parsedTileSize: 256 | 512 | undefined = tileSize === 256 || tileSize === 512 ? tileSize : undefined
    const shared = {
      demEncoding: encoding,
      tileTemplate,
      tileJsonUrl,
      ...(minZoom === null ? {} : { minZoom }),
      ...(maxZoom === null ? {} : { maxZoom }),
      ...(parsedTileSize === undefined ? {} : { tileSize: parsedTileSize }),
    }
    return path
      ? { status: 'available', ...shared, path }
      : { status: 'available', ...shared }
  }

  if (availabilityStatus === 'unavailable') {
    const reason = stringValue(availability?.error) ?? 'terrain PMTiles artifact is not present'
    return path
      ? { status: 'unavailable', reason, path }
      : { status: 'unavailable', reason }
  }

  return { status: 'unknown', reason: 'terrain capability has an invalid availability status' }
}

export const loadDroneWorldTerrainStatus = async (config: {
  readonly signal?: AbortSignal
} = {}): Promise<DroneWorldTerrainStatus> => {
  try {
    const response = await fetch('/map/capabilities.json', config.signal ? { signal: config.signal } : undefined)
    if (!response.ok) {
      return { status: 'unavailable', reason: `map capability query failed with HTTP ${response.status}` }
    }
    const body = await response.json() as unknown
    return terrainStatusFromManifest(body)
  } catch (error) {
    if (config.signal?.aborted) throw error
    return {
      status: 'unavailable',
      reason: error instanceof Error ? `map capability query failed: ${error.message}` : `map capability query failed: ${String(error)}`,
    }
  }
}

const cacheKeyFor = (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
}): string =>
  `${config.zoom}:${Math.round(config.radiusM)}:${config.center.lon.toFixed(6)}:${config.center.lat.toFixed(6)}`

const rememberCachedWorld = (
  key: string,
  promise: Promise<DroneMapWorldSnapshot>,
): void => {
  cachedWorldSnapshots.set(key, promise)
  while (cachedWorldSnapshots.size > maxCachedWorldSnapshots) {
    const oldestKey = cachedWorldSnapshots.keys().next().value
    if (typeof oldestKey !== 'string') break
    cachedWorldSnapshots.delete(oldestKey)
  }
}

export const loadDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
  readonly signal?: AbortSignal
}): Promise<DroneMapWorldSnapshot> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = Math.min(maxWorldZoom, config.zoom ?? maxWorldZoom)
  const tiles = tileRangeFor(config.center, radiusM, zoom)
  const decoded = await mapWithConcurrency(tiles, tileDecodeConcurrency, async tile => {
    const vectorTile = await fetchTile(tile, config.signal)
    if (!vectorTile) return { polygons: [], lines: [], points: [] }
    const layers = ['landcover', 'landuse', 'water', 'waterway', 'transportation', 'transportation_name', 'building', 'aeroway', 'place', 'poi']
    const layerFeatures = layers.map(layer => decodeLayer(vectorTile, tile, layer, config.center, radiusM))
    return {
      polygons: layerFeatures.flatMap(layer => layer.polygons),
      lines: layerFeatures.flatMap(layer => layer.lines),
      points: layerFeatures.flatMap(layer => layer.points),
    }
  })
  const decodedPolygons = decoded.flatMap(item => item.polygons)
  const decodedLines = decoded.flatMap(item => item.lines)
  const decodedPoints = decoded.flatMap(item => item.points)
  const mergedLines = mergeDroneWorldLinesForScenery(decodedLines)
  const polygons = selectWorldPolygons(decodedPolygons, radiusM)
  const lines = selectWorldLines(mergedLines, radiusM)
  const points = selectWorldPoints(decodedPoints)
  return {
    key: tileKeyFor(config.center, radiusM, zoom),
    center: config.center,
    radiusM,
    zoom,
    tileCount: tiles.length,
    polygons,
    lines,
    points,
    coverage: sceneryCoverageFor({
      decoded: { polygons: decodedPolygons, lines: decodedLines, points: decodedPoints },
      mergedLines,
      selectedPolygons: polygons,
      selectedLines: lines,
      selectedPoints: points,
    }),
  }
}

export const loadCachedDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
}): Promise<DroneMapWorldSnapshot> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = Math.min(maxWorldZoom, config.zoom ?? maxWorldZoom)
  const key = cacheKeyFor({ center: config.center, radiusM, zoom })
  const existing = cachedWorldSnapshots.get(key)
  if (existing) {
    worldCacheHits += 1
    return existing
  }
  worldCacheMisses += 1
  const promise = loadDroneMapWorld({ center: config.center, radiusM, zoom })
  rememberCachedWorld(key, promise)
  try {
    return await promise
  } catch (err) {
    cachedWorldSnapshots.delete(key)
    throw err
  }
}

export const droneMapWorldCacheStats = (): DroneMapWorldCacheStats => ({
  size: cachedWorldSnapshots.size,
  hits: worldCacheHits,
  misses: worldCacheMisses,
})

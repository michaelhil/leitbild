import type { SceneryRoadFeature, SceneryRoadTile, SceneryTileCoord } from '../../map/scenery.ts'
import { localPointFromLonLat, type DroneWorldCenter } from './drone-map-world.ts'

interface RoadTileBounds {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

interface RoadPoint {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly stationX?: number
  readonly stationZ?: number
}

interface RoadDirection {
  readonly x: number
  readonly z: number
  readonly nx: number
  readonly nz: number
}

interface RoadGeometryBuilder {
  readonly positions: number[]
  readonly indices: number[]
  readonly normals: number[]
}

export type RoadMaterialKey = 'road-asphalt' | 'road-marking-edge' | 'road-marking-center' | 'road-marking-lane'

interface RoadMeshBuilderEntry {
  readonly key: string
  readonly materialKey: RoadMaterialKey
  readonly colorHex: string
  readonly y: number
  readonly geometry: RoadGeometryBuilder
}

interface RoadLocalFeature {
  readonly key: string
  readonly feature: SceneryRoadFeature
  readonly y: number
  readonly layerKey: string
  readonly path: ReadonlyArray<RoadPoint>
  readonly distances: ReadonlyArray<number>
  readonly lengthM: number
}

interface RoadSegmentRef {
  readonly id: number
  readonly roadIndex: number
  readonly segmentIndex: number
  readonly layerKey: string
  readonly marked: boolean
  readonly start: RoadPoint
  readonly end: RoadPoint
  readonly startDistanceM: number
  readonly lengthM: number
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

interface RoadInterval {
  readonly startM: number
  readonly endM: number
}

export interface DroneRoadSurfaceMeshData {
  readonly key: string
  readonly materialKey: RoadMaterialKey
  readonly colorHex: string
  readonly y: number
  readonly positions: ReadonlyArray<number>
  readonly normals: ReadonlyArray<number>
  readonly indices: ReadonlyArray<number>
  readonly triangleCount: number
}

const roadSurfaceY = 1.56
const roadAsphaltColor = '#3f474b'
const roadEdgeLineColor = '#f8fafc'
const roadCenterLineColor = '#facc15'
const roadLaneLineColor = '#f8fafc'
const roadPaintLiftM = 0.12
const roadPaintWidthM = 0.56
const roadEdgeInsetM = 0.85
const roadEndpointPaintTrimM = 0
const roadIntersectionSearchPaddingM = 13
const roadMinPaintIntervalM = 2.8
const roadLaneDashLengthM = 4
const roadLaneDashGapM = 12
const roadMinLaneDashM = 1.8
const roadTargetLaneWidthM = 3.4
const roadMinMarkedLaneWidthM = 2.75
const roadMaxEstimatedLaneCount = 6
const roadSegmentBucketM = 42
const earthRadiusM = 6_378_137

const roadIntersectionPaintClearanceM = (
  feature: SceneryRoadFeature,
): number => Math.max(5, Math.min(13, feature.widthM * 0.8))

const roadMaterialColors: Record<RoadMaterialKey, string> = {
  'road-asphalt': roadAsphaltColor,
  'road-marking-edge': roadEdgeLineColor,
  'road-marking-center': roadCenterLineColor,
  'road-marking-lane': roadLaneLineColor,
}

const roadMaterialOrder: Record<RoadMaterialKey, number> = {
  'road-asphalt': 0,
  'road-marking-center': 1,
  'road-marking-lane': 2,
  'road-marking-edge': 3,
}

const paintableRoadClasses = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'minor',
  'residential',
  'unclassified',
])

const roadEdgeLineClasses = new Set([
  ...paintableRoadClasses,
  'service',
])

const tileXToLon = (x: number, z: number): number =>
  x / 2 ** z * 360 - 180

const tileYToLat = (y: number, z: number): number => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z
  return Math.atan(Math.sinh(n)) * 180 / Math.PI
}

const mercatorStation = (
  lon: number,
  lat: number,
): { readonly x: number; readonly z: number } => {
  const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180
  return {
    x: earthRadiusM * lon * Math.PI / 180,
    z: -earthRadiusM * Math.log(Math.tan(Math.PI / 4 + latRad / 2)),
  }
}

const tileBounds = (
  coord: SceneryTileCoord,
): RoadTileBounds => ({
  west: tileXToLon(coord.x, coord.z),
  east: tileXToLon(coord.x + 1, coord.z),
  north: tileYToLat(coord.y, coord.z),
  south: tileYToLat(coord.y + 1, coord.z),
})

const tileCenter = (
  bounds: RoadTileBounds,
): DroneWorldCenter => ({
  lon: (bounds.west + bounds.east) / 2,
  lat: (bounds.south + bounds.north) / 2,
})

export const roadTileUrlFromModelUrl = (
  modelUrl: string,
  roadTileTemplate: string,
): string | null => {
  const baseUrl = typeof window === 'undefined' ? 'http://leitbild.local/' : window.location.href
  const url = new URL(modelUrl, baseUrl)
  const match = url.pathname.match(/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.glb$/)
  if (!match) return null
  const [, recipeId, z, x, y] = match
  if (!recipeId || !z || !x || !y) return null
  return roadTileTemplate
    .replace('{recipeId}', recipeId)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
}

const roadSurfaceLayerY = (
  feature: SceneryRoadFeature,
  groundHeightM = 0,
): number | null => {
  if (feature.isTunnel) return null
  if (feature.isBridge) return groundHeightM + roadSurfaceY + Math.max(2.2, feature.verticalOffsetM)
  return groundHeightM + roadSurfaceY + Math.max(0, feature.verticalOffsetM)
}

const roadLayerKey = (
  y: number,
): string => `road:${Math.round(y * 100)}`

const roadMeshBuilderKey = (
  materialKey: RoadMaterialKey,
  layerKey: string,
): string => `${materialKey}:${layerKey}`

const roadPaintY = (
  y: number,
): number => y + roadPaintLiftM

const samePoint = (
  left: RoadPoint,
  right: RoadPoint,
  toleranceM = 0.08,
): boolean => Math.hypot(left.x - right.x, left.z - right.z) <= toleranceM

const compactPath = (
  path: ReadonlyArray<RoadPoint>,
): ReadonlyArray<RoadPoint> => {
  const compact: RoadPoint[] = []
  for (const point of path) {
    const previous = compact[compact.length - 1]
    if (previous && samePoint(previous, point, 0.16)) continue
    compact.push(point)
  }
  return compact
}

const normalizedDirection = (
  start: RoadPoint,
  end: RoadPoint,
): RoadDirection | null => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 0.05) return null
  const x = dx / length
  const z = dz / length
  return {
    x,
    z,
    nx: -z,
    nz: x,
  }
}

const miterPoint = (config: {
  readonly point: RoadPoint
  readonly previous: RoadDirection
  readonly next: RoadDirection
  readonly halfWidthM: number
  readonly side: 1 | -1
}): RoadPoint => {
  const normalX = config.previous.nx + config.next.nx
  const normalZ = config.previous.nz + config.next.nz
  const normalLength = Math.hypot(normalX, normalZ)
  if (normalLength < 0.0001) {
    return {
      x: config.point.x + config.next.nx * config.halfWidthM * config.side,
      y: config.point.y,
      z: config.point.z + config.next.nz * config.halfWidthM * config.side,
    }
  }
  const miterX = normalX / normalLength
  const miterZ = normalZ / normalLength
  const denominator = Math.max(0.28, Math.abs(miterX * config.next.nx + miterZ * config.next.nz))
  const length = Math.min(config.halfWidthM * 2.8, config.halfWidthM / denominator)
  return {
    x: config.point.x + miterX * length * config.side,
    y: config.point.y,
    z: config.point.z + miterZ * length * config.side,
  }
}

const appendVertex = (
  builder: RoadGeometryBuilder,
  point: RoadPoint,
  yOffsetM: number,
): number => {
  const index = builder.positions.length / 3
  builder.positions.push(point.x, point.y + yOffsetM, point.z)
  builder.normals.push(0, 1, 0)
  return index
}

const appendRoadRibbon = (
  builder: RoadGeometryBuilder,
  path: ReadonlyArray<RoadPoint>,
  widthM: number,
  yOffsetM: number,
  minHalfWidthM = 1.4,
): void => {
  const points = compactPath(path)
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2) return
  const closed = points.length >= 4 && samePoint(first, last)
  const roadPoints = closed ? points.slice(0, -1) : points
  if (roadPoints.length < 2) return
  const segmentCount = closed ? roadPoints.length : roadPoints.length - 1
  const directions = Array.from({ length: segmentCount }, (_value, index) => {
    const start = roadPoints[index]
    const end = roadPoints[(index + 1) % roadPoints.length]
    return start && end ? normalizedDirection(start, end) : null
  })
  if (directions.some(direction => direction === null)) return
  const validDirections = directions as ReadonlyArray<RoadDirection>
  const halfWidthM = Math.max(minHalfWidthM, widthM / 2)
  const leftIndexes: number[] = []
  const rightIndexes: number[] = []

  for (let index = 0; index < roadPoints.length; index += 1) {
    const point = roadPoints[index]
    if (!point) return
    const previous = closed
      ? validDirections[(index - 1 + validDirections.length) % validDirections.length]!
      : index === 0 ? validDirections[0]! : validDirections[index - 1]!
    const next = closed
      ? validDirections[index % validDirections.length]!
      : index >= validDirections.length ? validDirections[validDirections.length - 1]! : validDirections[index]!
    const left = !closed && index === 0
      ? { x: point.x + next.nx * halfWidthM, y: point.y, z: point.z + next.nz * halfWidthM }
      : !closed && index === roadPoints.length - 1
        ? { x: point.x + previous.nx * halfWidthM, y: point.y, z: point.z + previous.nz * halfWidthM }
        : miterPoint({ point, previous, next, halfWidthM, side: 1 })
    const right = !closed && index === 0
      ? { x: point.x - next.nx * halfWidthM, y: point.y, z: point.z - next.nz * halfWidthM }
      : !closed && index === roadPoints.length - 1
        ? { x: point.x - previous.nx * halfWidthM, y: point.y, z: point.z - previous.nz * halfWidthM }
        : miterPoint({ point, previous, next, halfWidthM, side: -1 })
    leftIndexes.push(appendVertex(builder, left, yOffsetM))
    rightIndexes.push(appendVertex(builder, right, yOffsetM))
  }

  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % roadPoints.length
    const leftStart = leftIndexes[index]
    const rightStart = rightIndexes[index]
    const leftEnd = leftIndexes[nextIndex]
    const rightEnd = rightIndexes[nextIndex]
    if (
      leftStart === undefined
      || rightStart === undefined
      || leftEnd === undefined
      || rightEnd === undefined
    ) continue
    builder.indices.push(leftStart, leftEnd, rightStart, rightStart, leftEnd, rightEnd)
  }
}

const pathDistances = (
  path: ReadonlyArray<RoadPoint>,
): ReadonlyArray<number> => {
  const distances = [0]
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1]
    const point = path[index]
    if (!previous || !point) return distances
    distances.push(distances[distances.length - 1]! + Math.hypot(point.x - previous.x, point.z - previous.z))
  }
  return distances
}

const pointAtDistance = (
  path: ReadonlyArray<RoadPoint>,
  distances: ReadonlyArray<number>,
  distanceM: number,
): RoadPoint | null => {
  const first = path[0]
  const last = path[path.length - 1]
  const total = distances[distances.length - 1]
  if (!first || !last || total === undefined) return null
  const clamped = Math.max(0, Math.min(total, distanceM))
  for (let index = 1; index < path.length; index += 1) {
    const endDistance = distances[index]
    if (endDistance === undefined || clamped > endDistance) continue
    const startDistance = distances[index - 1] ?? 0
    const start = path[index - 1]
    const end = path[index]
    if (!start || !end) return null
    const segmentLength = Math.max(0.0001, endDistance - startDistance)
    const t = (clamped - startDistance) / segmentLength
    const stationX = typeof start.stationX === 'number' && typeof end.stationX === 'number'
      ? start.stationX + (end.stationX - start.stationX) * t
      : undefined
    const stationZ = typeof start.stationZ === 'number' && typeof end.stationZ === 'number'
      ? start.stationZ + (end.stationZ - start.stationZ) * t
      : undefined
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
      ...(stationX === undefined || stationZ === undefined ? {} : { stationX, stationZ }),
    }
  }
  return last
}

const slicePathByDistance = (
  path: ReadonlyArray<RoadPoint>,
  distances: ReadonlyArray<number>,
  interval: RoadInterval,
): ReadonlyArray<RoadPoint> => {
  if (interval.endM - interval.startM < roadMinPaintIntervalM) return []
  const start = pointAtDistance(path, distances, interval.startM)
  const end = pointAtDistance(path, distances, interval.endM)
  if (!start || !end) return []
  const points: RoadPoint[] = [start]
  for (let index = 1; index < path.length - 1; index += 1) {
    const distance = distances[index]
    const point = path[index]
    if (distance === undefined || !point) continue
    if (distance > interval.startM + 0.05 && distance < interval.endM - 0.05) points.push(point)
  }
  points.push(end)
  return compactPath(points)
}

const offsetPath = (
  path: ReadonlyArray<RoadPoint>,
  offsetM: number,
): ReadonlyArray<RoadPoint> => {
  if (Math.abs(offsetM) < 0.001) return path
  const points = compactPath(path)
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2) return []
  const closed = points.length >= 4 && samePoint(first, last)
  const roadPoints = closed ? points.slice(0, -1) : points
  const segmentCount = closed ? roadPoints.length : roadPoints.length - 1
  const directions = Array.from({ length: segmentCount }, (_value, index) => {
    const start = roadPoints[index]
    const end = roadPoints[(index + 1) % roadPoints.length]
    return start && end ? normalizedDirection(start, end) : null
  })
  if (directions.some(direction => direction === null)) return []
  const validDirections = directions as ReadonlyArray<RoadDirection>
  const side: 1 | -1 = offsetM >= 0 ? 1 : -1
  const halfWidthM = Math.abs(offsetM)
  const shifted = roadPoints.flatMap((point, index): RoadPoint[] => {
    if (!point) return []
    const previous = closed
      ? validDirections[(index - 1 + validDirections.length) % validDirections.length]!
      : index === 0 ? validDirections[0]! : validDirections[index - 1]!
    const next = closed
      ? validDirections[index % validDirections.length]!
      : index >= validDirections.length ? validDirections[validDirections.length - 1]! : validDirections[index]!
    return [
      !closed && index === 0
        ? { x: point.x + next.nx * halfWidthM * side, y: point.y, z: point.z + next.nz * halfWidthM * side }
        : !closed && index === roadPoints.length - 1
          ? { x: point.x + previous.nx * halfWidthM * side, y: point.y, z: point.z + previous.nz * halfWidthM * side }
          : miterPoint({ point, previous, next, halfWidthM, side }),
    ]
  })
  return closed && shifted[0] ? [...shifted, shifted[0]] : shifted
}

const subtractBlockedIntervals = (
  interval: RoadInterval,
  blocks: ReadonlyArray<RoadInterval>,
): ReadonlyArray<RoadInterval> => {
  let allowed: RoadInterval[] = [interval]
  const sortedBlocks = [...blocks]
    .filter(block => block.endM > interval.startM && block.startM < interval.endM)
    .sort((left, right) => left.startM - right.startM)
  for (const block of sortedBlocks) {
    const nextAllowed: RoadInterval[] = []
    for (const candidate of allowed) {
      if (block.endM <= candidate.startM || block.startM >= candidate.endM) {
        nextAllowed.push(candidate)
        continue
      }
      if (block.startM > candidate.startM) {
        nextAllowed.push({ startM: candidate.startM, endM: Math.min(block.startM, candidate.endM) })
      }
      if (block.endM < candidate.endM) {
        nextAllowed.push({ startM: Math.max(block.endM, candidate.startM), endM: candidate.endM })
      }
    }
    allowed = nextAllowed
  }
  return allowed.filter(candidate => candidate.endM - candidate.startM >= roadMinPaintIntervalM)
}

const appendPaintRibbon = (config: {
  readonly builder: RoadGeometryBuilder
  readonly path: ReadonlyArray<RoadPoint>
  readonly distances: ReadonlyArray<number>
  readonly interval: RoadInterval
  readonly lateralOffsetM: number
  readonly yOffsetM: number
}): void => {
  const sliced = slicePathByDistance(config.path, config.distances, config.interval)
  if (sliced.length < 2) return
  const shifted = offsetPath(sliced, config.lateralOffsetM)
  if (shifted.length < 2) return
  appendRoadRibbon(config.builder, shifted, roadPaintWidthM, config.yOffsetM, roadPaintWidthM / 2)
}

const localRoadPoint = (config: {
  readonly point: readonly [number, number]
  readonly extent: number
  readonly bounds: RoadTileBounds
  readonly center: DroneWorldCenter
  readonly y: number
}): RoadPoint => {
  const lon = config.bounds.west + config.point[0] / config.extent * (config.bounds.east - config.bounds.west)
  const lat = config.bounds.north + config.point[1] / config.extent * (config.bounds.south - config.bounds.north)
  const local = localPointFromLonLat(lon, lat, config.center)
  const station = mercatorStation(lon, lat)
  return { x: local.x, y: config.y, z: local.z, stationX: station.x, stationZ: station.z }
}

const orderedRoads = (
  roads: ReadonlyArray<SceneryRoadFeature>,
): ReadonlyArray<SceneryRoadFeature> =>
  [...roads].sort((left, right) =>
    roadSurfaceLayerY(left) === null && roadSurfaceLayerY(right) !== null ? 1
      : roadSurfaceLayerY(left) !== null && roadSurfaceLayerY(right) === null ? -1
        : left.widthM - right.widthM || left.id.localeCompare(right.id),
  )

const buildLocalRoadFeatures = (config: {
  readonly roads: ReadonlyArray<SceneryRoadFeature>
  readonly bounds: RoadTileBounds
  readonly center: DroneWorldCenter
  readonly extent: number
}): ReadonlyArray<RoadLocalFeature> =>
  orderedRoads(config.roads).flatMap((feature, index): RoadLocalFeature[] => {
    const layerY = roadSurfaceLayerY(feature)
    if (layerY === null) return []
    const path = compactPath(feature.path.map((point, pointIndex) => localRoadPoint({
      point,
      extent: config.extent,
      bounds: config.bounds,
      center: config.center,
      y: roadSurfaceLayerY(feature, feature.heightSamplesM?.[pointIndex] ?? 0) ?? layerY,
    })))
    const distances = pathDistances(path)
    const lengthM = distances[distances.length - 1] ?? 0
    if (path.length < 2 || lengthM < 0.05) return []
    const y = path.reduce((sum, point) => sum + point.y, 0) / path.length
    return [{
      key: `${feature.id}:${index}`,
      feature,
      y,
      layerKey: roadLayerKey(layerY),
      path,
      distances,
      lengthM,
    }]
  })

const segmentCellRange = (
  min: number,
  max: number,
): readonly [number, number] => [
  Math.floor((min - roadIntersectionSearchPaddingM) / roadSegmentBucketM),
  Math.floor((max + roadIntersectionSearchPaddingM) / roadSegmentBucketM),
]

const segmentBucketKey = (
  layerKey: string,
  x: number,
  z: number,
): string => `${layerKey}:${x}:${z}`

const segmentPairsIntersect = (
  left: RoadSegmentRef,
  right: RoadSegmentRef,
): boolean =>
  left.minX <= right.maxX + 0.05
  && left.maxX >= right.minX - 0.05
  && left.minZ <= right.maxZ + 0.05
  && left.maxZ >= right.minZ - 0.05

const cross2 = (
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number => ax * bz - az * bx

const segmentIntersectionParameters = (
  left: RoadSegmentRef,
  right: RoadSegmentRef,
): { readonly leftT: number; readonly rightT: number } | null => {
  const rx = left.end.x - left.start.x
  const rz = left.end.z - left.start.z
  const sx = right.end.x - right.start.x
  const sz = right.end.z - right.start.z
  const denominator = cross2(rx, rz, sx, sz)
  if (Math.abs(denominator) < 0.0001) return null
  const qpx = right.start.x - left.start.x
  const qpz = right.start.z - left.start.z
  const leftT = cross2(qpx, qpz, sx, sz) / denominator
  const rightT = cross2(qpx, qpz, rx, rz) / denominator
  const tolerance = 0.015
  if (
    leftT < -tolerance
    || leftT > 1 + tolerance
    || rightT < -tolerance
    || rightT > 1 + tolerance
  ) return null
  return {
    leftT: Math.max(0, Math.min(1, leftT)),
    rightT: Math.max(0, Math.min(1, rightT)),
  }
}

const drawsRoadCenterLine = (
  feature: SceneryRoadFeature,
): boolean =>
  !feature.oneway
  && feature.widthM >= 8.8
  && paintableRoadClasses.has(feature.className)

const drawsRoadEdgeLines = (
  feature: SceneryRoadFeature,
): boolean =>
  feature.widthM >= 6.2
  && (roadEdgeLineClasses.has(feature.className) || feature.widthM >= 11.5)

const estimatedLaneCount = (
  feature: SceneryRoadFeature,
): number => {
  const usableWidthM = feature.widthM - roadEdgeInsetM * 2
  const minimumLaneCount = feature.oneway ? 1 : 2
  if (usableWidthM < minimumLaneCount * roadMinMarkedLaneWidthM) return minimumLaneCount
  const rawLaneCount = Math.max(minimumLaneCount, Math.round(usableWidthM / roadTargetLaneWidthM))
  const directionAwareLaneCount = feature.oneway || rawLaneCount % 2 === 0
    ? rawLaneCount
    : rawLaneCount - 1
  return Math.max(
    minimumLaneCount,
    Math.min(roadMaxEstimatedLaneCount, directionAwareLaneCount),
  )
}

const roadLaneDividerOffsets = (
  feature: SceneryRoadFeature,
): ReadonlyArray<number> => {
  if (!paintableRoadClasses.has(feature.className)) return []
  if (feature.widthM < (feature.oneway ? 10.5 : 15.5)) return []
  const laneCount = estimatedLaneCount(feature)
  if (laneCount < 2) return []
  const usableWidthM = Math.max(0, feature.widthM - roadEdgeInsetM * 2)
  const laneWidthM = usableWidthM / laneCount
  const offsets: number[] = []
  for (let laneBoundary = 1; laneBoundary < laneCount; laneBoundary += 1) {
    const offsetM = -usableWidthM / 2 + laneWidthM * laneBoundary
    const isBidirectionalCenter = !feature.oneway && Math.abs(offsetM) < laneWidthM * 0.4
    if (isBidirectionalCenter) continue
    offsets.push(offsetM)
  }
  return offsets
}

const drawsAnyRoadMarking = (
  feature: SceneryRoadFeature,
): boolean => drawsRoadCenterLine(feature) || drawsRoadEdgeLines(feature) || roadLaneDividerOffsets(feature).length > 0

const positiveModulo = (
  value: number,
  divisor: number,
): number => ((value % divisor) + divisor) % divisor

const dashPhaseForRoad = (
  road: RoadLocalFeature,
): number => {
  const first = road.path[0]
  const next = road.path.find((point, index) => index > 0 && first && Math.hypot(point.x - first.x, point.z - first.z) > 1)
  if (!first || !next) return 0
  const firstStationX = first.stationX ?? first.x
  const firstStationZ = first.stationZ ?? first.z
  const nextStationX = next.stationX ?? next.x
  const nextStationZ = next.stationZ ?? next.z
  const dx = nextStationX - firstStationX
  const dz = nextStationZ - firstStationZ
  const lengthM = Math.hypot(dx, dz)
  if (lengthM < 0.001) return 0
  return positiveModulo(
    firstStationX * dx / lengthM + firstStationZ * dz / lengthM,
    roadLaneDashLengthM + roadLaneDashGapM,
  )
}

const dashedIntervals = (
  interval: RoadInterval,
  phaseM: number,
): ReadonlyArray<RoadInterval> => {
  const periodM = roadLaneDashLengthM + roadLaneDashGapM
  const normalizedPhaseM = positiveModulo(phaseM, periodM)
  const intervals: RoadInterval[] = []
  let cursorM = -normalizedPhaseM
  while (cursorM < interval.endM) {
    const startM = Math.max(interval.startM, cursorM)
    const endM = Math.min(interval.endM, cursorM + roadLaneDashLengthM)
    if (endM - startM >= roadMinLaneDashM) intervals.push({ startM, endM })
    cursorM += periodM
  }
  return intervals
}

const roadMarkingSuppressionDistances = (
  roads: ReadonlyArray<RoadLocalFeature>,
): ReadonlyMap<string, ReadonlyArray<number>> => {
  const markedRoadKeys = new Set(roads.filter(road => drawsAnyRoadMarking(road.feature)).map(road => road.key))
  const distancesByRoad = new Map(roads.map(road => [road.key, [] as number[]]))
  const segments: RoadSegmentRef[] = []
  for (const [roadIndex, road] of roads.entries()) {
    for (let segmentIndex = 0; segmentIndex < road.path.length - 1; segmentIndex += 1) {
      const start = road.path[segmentIndex]
      const end = road.path[segmentIndex + 1]
      const startDistanceM = road.distances[segmentIndex]
      const endDistanceM = road.distances[segmentIndex + 1]
      if (!start || !end || startDistanceM === undefined || endDistanceM === undefined) continue
      const lengthM = endDistanceM - startDistanceM
      if (lengthM < 0.05) continue
      segments.push({
        id: segments.length,
        roadIndex,
        segmentIndex,
        layerKey: road.layerKey,
        marked: markedRoadKeys.has(road.key),
        start,
        end,
        startDistanceM,
        lengthM,
        minX: Math.min(start.x, end.x),
        maxX: Math.max(start.x, end.x),
        minZ: Math.min(start.z, end.z),
        maxZ: Math.max(start.z, end.z),
      })
    }
  }

  const buckets = new Map<string, number[]>()
  const markedBuckets = new Map<string, number[]>()
  for (const segment of segments) {
    const [minCellX, maxCellX] = segmentCellRange(segment.minX, segment.maxX)
    const [minCellZ, maxCellZ] = segmentCellRange(segment.minZ, segment.maxZ)
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const key = segmentBucketKey(segment.layerKey, cellX, cellZ)
        const bucket = buckets.get(key) ?? []
        if (!buckets.has(key)) buckets.set(key, bucket)
        bucket.push(segment.id)
        if (segment.marked) {
          const markedBucket = markedBuckets.get(key) ?? []
          if (!markedBuckets.has(key)) markedBuckets.set(key, markedBucket)
          markedBucket.push(segment.id)
        }
      }
    }
  }

  const seenPairs = new Set<string>()
  for (const [key, markedBucket] of markedBuckets.entries()) {
    const bucket = buckets.get(key) ?? []
    for (const markedSegmentId of markedBucket) {
      for (const blockerSegmentId of bucket) {
        if (markedSegmentId === blockerSegmentId) continue
        const left = segments[markedSegmentId]
        const right = segments[blockerSegmentId]
        if (!left || !right || left.layerKey !== right.layerKey) continue
        const leftRoad = roads[left.roadIndex]
        const rightRoad = roads[right.roadIndex]
        if (!leftRoad || !rightRoad) continue
        const leftMarked = left.marked
        const rightMarked = right.marked
        if (!leftMarked && !rightMarked) continue
        const sameRoad = left.roadIndex === right.roadIndex
        if (sameRoad && Math.abs(left.segmentIndex - right.segmentIndex) <= 1) continue
        const pairKey = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)
        if (!segmentPairsIntersect(left, right)) continue
        const intersection = segmentIntersectionParameters(left, right)
        if (!intersection) continue
        if (leftMarked) {
          distancesByRoad.get(leftRoad.key)?.push(left.startDistanceM + intersection.leftT * left.lengthM)
        }
        if (rightMarked) {
          distancesByRoad.get(rightRoad.key)?.push(right.startDistanceM + intersection.rightT * right.lengthM)
        }
      }
    }
  }

  return distancesByRoad
}

const markingIntervalsForRoad = (
  road: RoadLocalFeature,
  suppressionDistances: ReadonlyArray<number>,
): ReadonlyArray<RoadInterval> => {
  if (road.lengthM <= roadEndpointPaintTrimM * 2 + roadMinPaintIntervalM) return []
  const intersectionClearanceM = roadIntersectionPaintClearanceM(road.feature)
  return subtractBlockedIntervals(
    {
      startM: roadEndpointPaintTrimM,
      endM: road.lengthM - roadEndpointPaintTrimM,
    },
    suppressionDistances.map(distanceM => ({
      startM: Math.max(0, distanceM - intersectionClearanceM),
      endM: Math.min(road.lengthM, distanceM + intersectionClearanceM),
    })),
  )
}

export const buildRoadSurfaceMeshes = (config: {
  readonly tile: SceneryRoadTile
  readonly center?: DroneWorldCenter
}): ReadonlyArray<DroneRoadSurfaceMeshData> => {
  const bounds = tileBounds(config.tile.tile)
  const center = config.center ?? tileCenter(bounds)
  const roads = buildLocalRoadFeatures({
    roads: config.tile.roads,
    bounds,
    center,
    extent: config.tile.tile.extent,
  })
  const builders = new Map<string, RoadMeshBuilderEntry>()
  const builderFor = (
    materialKey: RoadMaterialKey,
    y: number,
    layerKey: string,
  ): RoadMeshBuilderEntry => {
    const key = roadMeshBuilderKey(materialKey, layerKey)
    const entry = builders.get(key) ?? {
      key,
      materialKey,
      colorHex: roadMaterialColors[materialKey],
      y,
      geometry: {
        positions: [],
        indices: [],
        normals: [],
      },
    }
    if (!builders.has(key)) builders.set(key, entry)
    return entry
  }

  for (const road of roads) {
    appendRoadRibbon(
      builderFor('road-asphalt', road.y, road.layerKey).geometry,
      road.path,
      road.feature.widthM,
      0,
    )
  }

  const intersections = roadMarkingSuppressionDistances(roads)
  for (const road of roads) {
    const intervals = markingIntervalsForRoad(road, intersections.get(road.key) ?? [])
    if (intervals.length === 0) continue
    const paintY = roadPaintY(road.y)
    const dashPhaseM = dashPhaseForRoad(road)
    if (drawsRoadCenterLine(road.feature)) {
      const builder = builderFor('road-marking-center', paintY, road.layerKey).geometry
      for (const interval of intervals) {
        for (const dashInterval of dashedIntervals(interval, dashPhaseM)) {
          appendPaintRibbon({
            builder,
            path: road.path,
            distances: road.distances,
            interval: dashInterval,
            lateralOffsetM: 0,
            yOffsetM: roadPaintLiftM,
          })
        }
      }
    }
    const laneDividerOffsets = roadLaneDividerOffsets(road.feature)
    if (laneDividerOffsets.length > 0) {
      const builder = builderFor('road-marking-lane', paintY, road.layerKey).geometry
      for (const interval of intervals) {
        for (const dashInterval of dashedIntervals(interval, dashPhaseM)) {
          for (const lateralOffsetM of laneDividerOffsets) {
            appendPaintRibbon({
              builder,
              path: road.path,
              distances: road.distances,
              interval: dashInterval,
              lateralOffsetM,
              yOffsetM: roadPaintLiftM,
            })
          }
        }
      }
    }
    if (drawsRoadEdgeLines(road.feature)) {
      const halfWidthM = Math.max(1.4, road.feature.widthM / 2)
      const offsetM = Math.max(0, halfWidthM - roadEdgeInsetM)
      if (offsetM > roadPaintWidthM * 2) {
        const builder = builderFor('road-marking-edge', paintY, road.layerKey).geometry
        for (const interval of intervals) {
          appendPaintRibbon({
            builder,
            path: road.path,
            distances: road.distances,
            interval,
            lateralOffsetM: offsetM,
            yOffsetM: roadPaintLiftM,
          })
          appendPaintRibbon({
            builder,
            path: road.path,
            distances: road.distances,
            interval,
            lateralOffsetM: -offsetM,
            yOffsetM: roadPaintLiftM,
          })
        }
      }
    }
  }

  return [...builders.entries()]
    .filter(([, entry]) => entry.geometry.indices.length > 0)
    .sort(([, left], [, right]) =>
      left.y - right.y
      || roadMaterialOrder[left.materialKey] - roadMaterialOrder[right.materialKey]
      || left.key.localeCompare(right.key),
    )
    .map(([key, entry]) => ({
      key,
      materialKey: entry.materialKey,
      colorHex: entry.colorHex,
      y: entry.y,
      positions: entry.geometry.positions,
      normals: entry.geometry.normals,
      indices: entry.geometry.indices,
      triangleCount: entry.geometry.indices.length / 3,
    }))
}

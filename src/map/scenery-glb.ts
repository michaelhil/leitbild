import earcut from 'earcut'
import type {
  SceneryAssetTileSummary,
  SceneryPoint,
  SceneryTile,
  SceneryTileQualityAudit,
  SceneryTileQualityFinding,
} from './scenery.ts'

interface TileLonLat {
  readonly lon: number
  readonly lat: number
}

interface LocalPoint {
  readonly x: number
  readonly z: number
}

interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

type SceneryDepthPolicy = 'base-surface' | 'integrated-facade' | 'raised-geometry'

interface MaterialSpec {
  readonly key: string
  readonly name: string
  readonly color: readonly [number, number, number, number]
  readonly depthPolicy: SceneryDepthPolicy
  readonly metallicFactor?: number
  readonly roughnessFactor?: number
  readonly doubleSided?: boolean
  readonly emissiveFactor?: readonly [number, number, number]
}

interface MeshBucket {
  readonly name: string
  readonly materialKey: string
  readonly positions: number[]
  readonly normals: number[]
  readonly indices: number[]
}

interface PrimitiveSpec {
  readonly name: string
  readonly materialKey: string
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
}

interface SceneryGlbBuildResult {
  readonly bytes: Uint8Array
  readonly summary: Omit<SceneryAssetTileSummary, 'byteLength'>
}

interface SceneryGlbLodProfile {
  readonly lineSimplifyDistanceM: number
  readonly minBuildingAreaM2: number
  readonly minRoadPriority: number
  readonly includeFacadeTrim: boolean
  readonly includeFacadeWindows: boolean
  readonly includeRoofParapets: boolean
  readonly includeRoofFixtures: boolean
  readonly includeRoadMarkings: boolean
  readonly includeStreetLights: boolean
  readonly includePoiBeacons: boolean
  readonly facadeWindowCellBudget: number
  readonly facadeTrimBandBudget: number
  readonly roofParapetSegmentBudget: number
  readonly roofFixtureBudget: number
  readonly roadEdgeRibbonPairBudget: number
  readonly roadMarkingDashBudget: number
  readonly streetLightBudget: number
  readonly poiBeaconBudget: number
  readonly vegetationMaxPerTile: number
  readonly vegetationNaturalAreaM2: number
  readonly vegetationResidentialAreaM2: number
}

interface SceneryDetailBudget {
  facadeWindowCellsRemaining: number
  facadeTrimBandsRemaining: number
  roofParapetSegmentsRemaining: number
  roofFixturesRemaining: number
  roadEdgeRibbonPairsRemaining: number
  roadMarkingDashesRemaining: number
  streetLightsRemaining: number
  poiBeaconsRemaining: number
}

const metersPerDegreeLat = 111_320
const defaultMaxScreenSpaceError = 16
const facadeTrimReliefM = 0.055
const facadeWindowReliefM = 0.085
const ribbonJoinLiftM = 0.065
const horizontalDepth = {
  landcoverBaseY: 0.04,
  landuseBaseY: 0.18,
  waterSurfaceY: 0.38,
  wetlandBaseY: 0.48,
  urbanBaseY: 0.60,
  woodlandBaseY: 0.72,
  aerowaySurfaceY: 0.78,
  waterwayY: 0.84,
  railCasingY: 0.98,
  railSteelY: 1.12,
  aerowayShoulderY: 1.26,
  aerowayFillY: 1.34,
  roadBaseY: 1.40,
  roadFeatureLaneStepM: 0.52,
  roadCasingLiftM: 0.11,
  roadFillLiftM: 0.23,
  roadEdgeMarkingLiftM: 0.36,
  roadCenterMarkingLiftM: 0.46,
  roofMaterialLiftStepM: 0.075,
} as const

const lodProfileForZoom = (
  zoom: number,
): SceneryGlbLodProfile => {
  if (zoom <= 12) {
    return {
      lineSimplifyDistanceM: 2.2,
      minBuildingAreaM2: 120,
      minRoadPriority: 50,
      includeFacadeTrim: false,
      includeFacadeWindows: false,
      includeRoofParapets: false,
      includeRoofFixtures: false,
      includeRoadMarkings: false,
      includeStreetLights: false,
      includePoiBeacons: false,
      facadeWindowCellBudget: 0,
      facadeTrimBandBudget: 0,
      roofParapetSegmentBudget: 0,
      roofFixtureBudget: 0,
      roadEdgeRibbonPairBudget: 0,
      roadMarkingDashBudget: 0,
      streetLightBudget: 0,
      poiBeaconBudget: 0,
      vegetationMaxPerTile: 0,
      vegetationNaturalAreaM2: 20_000,
      vegetationResidentialAreaM2: 40_000,
    }
  }
  if (zoom === 13) {
    return {
      lineSimplifyDistanceM: 0.9,
      minBuildingAreaM2: 32,
      minRoadPriority: 40,
      includeFacadeTrim: false,
      includeFacadeWindows: false,
      includeRoofParapets: false,
      includeRoofFixtures: false,
      includeRoadMarkings: false,
      includeStreetLights: false,
      includePoiBeacons: false,
      facadeWindowCellBudget: 0,
      facadeTrimBandBudget: 0,
      roofParapetSegmentBudget: 0,
      roofFixtureBudget: 0,
      roadEdgeRibbonPairBudget: 0,
      roadMarkingDashBudget: 0,
      streetLightBudget: 0,
      poiBeaconBudget: 0,
      vegetationMaxPerTile: 48,
      vegetationNaturalAreaM2: 14_000,
      vegetationResidentialAreaM2: 32_000,
    }
  }
  return {
    lineSimplifyDistanceM: 0.35,
    minBuildingAreaM2: 0,
    minRoadPriority: 30,
    includeFacadeTrim: true,
    includeFacadeWindows: true,
    includeRoofParapets: true,
    includeRoofFixtures: true,
    includeRoadMarkings: true,
    includeStreetLights: true,
    includePoiBeacons: true,
    facadeWindowCellBudget: 11_000,
    facadeTrimBandBudget: 2_200,
    roofParapetSegmentBudget: 2_400,
    roofFixtureBudget: 240,
    roadEdgeRibbonPairBudget: 360,
    roadMarkingDashBudget: 1_800,
    streetLightBudget: 520,
    poiBeaconBudget: 48,
    vegetationMaxPerTile: 160,
    vegetationNaturalAreaM2: 5_400,
    vegetationResidentialAreaM2: 16_000,
  }
}

const detailBudgetForProfile = (
  profile: SceneryGlbLodProfile,
): SceneryDetailBudget => ({
  facadeWindowCellsRemaining: profile.facadeWindowCellBudget,
  facadeTrimBandsRemaining: profile.facadeTrimBandBudget,
  roofParapetSegmentsRemaining: profile.roofParapetSegmentBudget,
  roofFixturesRemaining: profile.roofFixtureBudget,
  roadEdgeRibbonPairsRemaining: profile.roadEdgeRibbonPairBudget,
  roadMarkingDashesRemaining: profile.roadMarkingDashBudget,
  streetLightsRemaining: profile.streetLightBudget,
  poiBeaconsRemaining: profile.poiBeaconBudget,
})

const materials: ReadonlyArray<MaterialSpec> = [
  { key: 'ground-grass', name: 'ground grass varied', color: [0.34, 0.49, 0.29, 1], depthPolicy: 'base-surface', roughnessFactor: 0.94, doubleSided: true },
  { key: 'ground-park', name: 'managed park grass', color: [0.28, 0.55, 0.25, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'ground-field', name: 'field and farmland ground', color: [0.48, 0.54, 0.30, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'ground-wetland', name: 'wetland ground', color: [0.26, 0.42, 0.35, 1], depthPolicy: 'base-surface', roughnessFactor: 0.98, doubleSided: true },
  { key: 'ground-urban', name: 'urban ground', color: [0.58, 0.60, 0.55, 1], depthPolicy: 'base-surface', roughnessFactor: 0.9, doubleSided: true },
  { key: 'ground-wood', name: 'woodland floor', color: [0.18, 0.42, 0.22, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'water', name: 'water surface', color: [0.08, 0.49, 0.72, 1], depthPolicy: 'base-surface', roughnessFactor: 0.36, metallicFactor: 0.02, doubleSided: true },
  { key: 'road-shoulder', name: 'road shoulder', color: [0.70, 0.67, 0.58, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'road-casing', name: 'road dark casing', color: [0.12, 0.14, 0.17, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'road-fill', name: 'road asphalt', color: [0.38, 0.41, 0.42, 1], depthPolicy: 'base-surface', roughnessFactor: 0.72, doubleSided: true },
  { key: 'road-major-fill', name: 'major road asphalt', color: [0.30, 0.34, 0.38, 1], depthPolicy: 'base-surface', roughnessFactor: 0.7, doubleSided: true },
  { key: 'road-marking', name: 'baked road markings', color: [0.96, 0.94, 0.78, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.62, doubleSided: true },
  { key: 'rail', name: 'rail steel', color: [0.55, 0.61, 0.68, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.42, metallicFactor: 0.45, doubleSided: true },
  { key: 'building-wall', name: 'building wall', color: [0.73, 0.72, 0.67, 1], depthPolicy: 'base-surface', roughnessFactor: 0.72, doubleSided: true },
  { key: 'building-wall-warm', name: 'warm building wall', color: [0.76, 0.66, 0.55, 1], depthPolicy: 'base-surface', roughnessFactor: 0.74, doubleSided: true },
  { key: 'building-wall-cool', name: 'cool building wall', color: [0.67, 0.71, 0.73, 1], depthPolicy: 'base-surface', roughnessFactor: 0.68, doubleSided: true },
  { key: 'building-wall-brick', name: 'brick building wall', color: [0.64, 0.36, 0.28, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'building-wall-stone', name: 'stone building wall', color: [0.61, 0.57, 0.51, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-wall-dark', name: 'dark glass building wall', color: [0.36, 0.41, 0.45, 1], depthPolicy: 'base-surface', roughnessFactor: 0.52, metallicFactor: 0.02, doubleSided: true },
  { key: 'building-roof', name: 'building roof', color: [0.40, 0.44, 0.49, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'building-roof-light', name: 'light building roof', color: [0.64, 0.65, 0.61, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-roof-green', name: 'green copper roof', color: [0.37, 0.57, 0.50, 1], depthPolicy: 'base-surface', roughnessFactor: 0.7, metallicFactor: 0.08, doubleSided: true },
  { key: 'building-roof-red', name: 'red tile roof', color: [0.57, 0.25, 0.18, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-roof-dark', name: 'dark roof membrane', color: [0.22, 0.25, 0.29, 1], depthPolicy: 'base-surface', roughnessFactor: 0.74, doubleSided: true },
  { key: 'roof-parapet', name: 'roof parapets', color: [0.58, 0.60, 0.58, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.8, doubleSided: true },
  { key: 'roof-fixture', name: 'rooftop fixtures', color: [0.50, 0.53, 0.55, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.62, metallicFactor: 0.05 },
  { key: 'building-window', name: 'building windows', color: [0.34, 0.58, 0.76, 1], depthPolicy: 'integrated-facade', roughnessFactor: 0.2, metallicFactor: 0.02, emissiveFactor: [0.015, 0.035, 0.055], doubleSided: true },
  { key: 'building-trim', name: 'building facade trim', color: [0.55, 0.58, 0.57, 1], depthPolicy: 'integrated-facade', roughnessFactor: 0.76, doubleSided: true },
  { key: 'tree-trunk', name: 'tree trunks', color: [0.38, 0.22, 0.12, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.92 },
  { key: 'tree-canopy', name: 'tree canopy', color: [0.16, 0.48, 0.22, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.98 },
  { key: 'tree-canopy-light', name: 'tree canopy light', color: [0.25, 0.58, 0.28, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.98 },
  { key: 'street-light', name: 'street light poles', color: [0.36, 0.40, 0.45, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.64, metallicFactor: 0.2 },
  { key: 'street-lamp', name: 'street lamp glass', color: [1.0, 0.82, 0.36, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.3, emissiveFactor: [0.45, 0.32, 0.08] },
  { key: 'poi', name: 'poi beacon', color: [0.16, 0.69, 0.95, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.36, emissiveFactor: [0.02, 0.18, 0.32] },
]

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = Math.imul(1664525, state) + 1013904223
    return (state >>> 0) / 0xffffffff
  }
}

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const tilePointToLonLat = (
  point: SceneryPoint,
  tile: SceneryTile['tile'],
): TileLonLat => {
  const size = tile.extent * 2 ** tile.z
  const worldX = point[0] + tile.extent * tile.x
  const worldY = point[1] + tile.extent * tile.y
  return {
    lon: worldX * 360 / size - 180,
    lat: 360 / Math.PI * Math.atan(Math.exp((1 - worldY * 2 / size) * Math.PI)) - 90,
  }
}

export const sceneryTileCenterLonLat = (
  tile: Pick<SceneryTile['tile'], 'z' | 'x' | 'y'>,
): TileLonLat => {
  const size = 2 ** tile.z
  const lon = (tile.x + 0.5) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

const tileCornerLonLat = (
  tile: Pick<SceneryTile['tile'], 'z' | 'x' | 'y'>,
  cornerX: number,
  cornerY: number,
): TileLonLat => {
  const size = 2 ** tile.z
  const lon = (tile.x + cornerX) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + cornerY) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

const sceneryTileBounds = (
  tile: Pick<SceneryTile['tile'], 'z' | 'x' | 'y'>,
): SceneryAssetTileSummary['bounds'] => {
  const northWest = tileCornerLonLat(tile, 0, 0)
  const southEast = tileCornerLonLat(tile, 1, 1)
  return {
    minLon: northWest.lon,
    minLat: southEast.lat,
    maxLon: southEast.lon,
    maxLat: northWest.lat,
  }
}

const tileSizeMeters = (
  bounds: SceneryAssetTileSummary['bounds'],
  center: TileLonLat,
): { readonly widthM: number; readonly heightM: number; readonly diagonalM: number } => {
  const widthM = Math.abs(bounds.maxLon - bounds.minLon) * metersPerDegreeLonAt(center.lat)
  const heightM = Math.abs(bounds.maxLat - bounds.minLat) * metersPerDegreeLat
  return { widthM, heightM, diagonalM: Math.hypot(widthM, heightM) }
}

const lodForTile = (
  tile: Pick<SceneryTile['tile'], 'z' | 'x' | 'y'>,
  bounds: SceneryAssetTileSummary['bounds'],
  center: TileLonLat,
): SceneryAssetTileSummary['lod'] => {
  const size = tileSizeMeters(bounds, center)
  return {
    zoom: tile.z,
    geometricErrorM: Math.max(0.75, Math.max(size.widthM, size.heightM) / 128),
    maxScreenSpaceError: defaultMaxScreenSpaceError,
  }
}

const localPointFromSceneryPoint = (
  point: SceneryPoint,
  tile: SceneryTile['tile'],
  center: TileLonLat,
): LocalPoint => {
  const lonLat = tilePointToLonLat(point, tile)
  return {
    x: (lonLat.lon - center.lon) * metersPerDegreeLonAt(center.lat),
    z: -(lonLat.lat - center.lat) * metersPerDegreeLat,
  }
}

const openRing = (
  ring: ReadonlyArray<LocalPoint>,
): ReadonlyArray<LocalPoint> => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (!first || !last || ring.length < 2) return ring
  return Math.hypot(first.x - last.x, first.z - last.z) < 0.001 ? ring.slice(0, -1) : ring
}

const ringArea = (ring: ReadonlyArray<LocalPoint>): number => {
  let area = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!
    const next = ring[(index + 1) % ring.length]!
    area += current.x * next.z - next.x * current.z
  }
  return area / 2
}

const pointInRing = (
  point: LocalPoint,
  ring: ReadonlyArray<LocalPoint>,
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

const polygonCentroid = (
  ring: ReadonlyArray<LocalPoint>,
): LocalPoint => {
  if (ring.length === 0) return { x: 0, z: 0 }
  let signedArea = 0
  let cx = 0
  let cz = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!
    const next = ring[(index + 1) % ring.length]!
    const cross = current.x * next.z - next.x * current.z
    signedArea += cross
    cx += (current.x + next.x) * cross
    cz += (current.z + next.z) * cross
  }
  const area = signedArea * 0.5
  if (Math.abs(area) < 0.001) {
    return {
      x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
      z: ring.reduce((sum, point) => sum + point.z, 0) / ring.length,
    }
  }
  return { x: cx / (6 * area), z: cz / (6 * area) }
}

const boundsForRing = (
  ring: ReadonlyArray<LocalPoint>,
): { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number } => {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const point of ring) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }
  return { minX, maxX, minZ, maxZ }
}

const bucketFor = (
  buckets: Map<string, MeshBucket>,
  key: string,
  name: string,
): MeshBucket => {
  const existing = buckets.get(key)
  if (existing) return existing
  const bucket: MeshBucket = {
    name,
    materialKey: key,
    positions: [],
    normals: [],
    indices: [],
  }
  buckets.set(key, bucket)
  return bucket
}

const appendVertex = (
  bucket: MeshBucket,
  position: Vec3,
  normal: Vec3,
): number => {
  const index = bucket.positions.length / 3
  bucket.positions.push(position.x, position.y, position.z)
  bucket.normals.push(normal.x, normal.y, normal.z)
  return index
}

const appendQuad = (
  bucket: MeshBucket,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  normal: Vec3,
): void => {
  const base = bucket.positions.length / 3
  appendVertex(bucket, a, normal)
  appendVertex(bucket, b, normal)
  appendVertex(bucket, c, normal)
  appendVertex(bucket, d, normal)
  bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

const appendHorizontalPolygon = (
  bucket: MeshBucket,
  rings: ReadonlyArray<ReadonlyArray<LocalPoint>>,
  y: number,
): void => {
  const normalizedRings = rings.map(openRing).filter(ring => ring.length >= 3)
  const outer = normalizedRings[0]
  if (!outer) return
  const holes = normalizedRings.slice(1)
  const vertices = [...outer, ...holes.flatMap(ring => ring)]
  const coordinates: number[] = []
  const holeIndices: number[] = []
  let vertexOffset = outer.length
  for (const point of outer) coordinates.push(point.x, -point.z)
  for (const hole of holes) {
    holeIndices.push(vertexOffset)
    vertexOffset += hole.length
    for (const point of hole) coordinates.push(point.x, -point.z)
  }
  const triangles = earcut(coordinates, holeIndices, 2)
  if (triangles.length === 0) return
  const base = bucket.positions.length / 3
  for (const point of vertices) appendVertex(bucket, { x: point.x, y, z: point.z }, { x: 0, y: 1, z: 0 })
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index]
    const b = triangles[index + 1]
    const c = triangles[index + 2]
    if (a === undefined || b === undefined || c === undefined) continue
    bucket.indices.push(base + a, base + b, base + c)
  }
}

const appendWallSpan = (
  bucket: MeshBucket,
  start: LocalPoint,
  ux: number,
  uz: number,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  normal: Vec3,
  normalOffsetM = 0,
): void => {
  if (u1 - u0 < 0.035 || y1 - y0 < 0.035) return
  const offsetX = normal.x * normalOffsetM
  const offsetZ = normal.z * normalOffsetM
  appendQuad(
    bucket,
    { x: start.x + ux * u0 + offsetX, y: y0, z: start.z + uz * u0 + offsetZ },
    { x: start.x + ux * u1 + offsetX, y: y0, z: start.z + uz * u1 + offsetZ },
    { x: start.x + ux * u1 + offsetX, y: y1, z: start.z + uz * u1 + offsetZ },
    { x: start.x + ux * u0 + offsetX, y: y1, z: start.z + uz * u0 + offsetZ },
    normal,
  )
}

const outwardWallNormal = (
  dx: number,
  dz: number,
  length: number,
  ringSignedAreaM2: number,
): Vec3 => {
  const leftNormal = { x: -dz / length, y: 0, z: dx / length }
  const sign = ringSignedAreaM2 >= 0 ? -1 : 1
  return { x: leftNormal.x * sign, y: 0, z: leftNormal.z * sign }
}

const appendFacadeWindowCell = (
  bucket: MeshBucket,
  start: LocalPoint,
  ux: number,
  uz: number,
  cellU0: number,
  cellU1: number,
  y0: number,
  y1: number,
  normal: Vec3,
): void => {
  const cellWidth = cellU1 - cellU0
  const cellHeight = y1 - y0
  const horizontalInset = Math.min(0.42, cellWidth * 0.22)
  const verticalInset = Math.min(0.46, cellHeight * 0.24)
  appendWallSpan(
    bucket,
    start,
    ux,
    uz,
    cellU0 + horizontalInset,
    cellU1 - horizontalInset,
    y0 + verticalInset,
    y0 + Math.max(verticalInset + 0.2, cellHeight * 0.68),
    normal,
    facadeWindowReliefM,
  )
}

const appendBuildingWalls = (
  wallBucket: MeshBucket,
  windowBucket: MeshBucket,
  trimBucket: MeshBucket,
  rings: ReadonlyArray<ReadonlyArray<LocalPoint>>,
  minHeight: number,
  height: number,
  seed: number,
  profile: SceneryGlbLodProfile,
  budget: SceneryDetailBudget,
): void => {
  const random = seededRandom(seed)
  for (const sourceRing of rings) {
    const ring = openRing(sourceRing)
    if (ring.length < 2) continue
    const ringSignedAreaM2 = ringArea(ring)
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index]!
      const end = ring[(index + 1) % ring.length]!
      const dx = end.x - start.x
      const dz = end.z - start.z
      const length = Math.hypot(dx, dz)
      if (length < 0.15) continue
      const normal = outwardWallNormal(dx, dz, length, ringSignedAreaM2)
      const ux = dx / length
      const uz = dz / length
      appendWallSpan(wallBucket, start, ux, uz, 0, length, minHeight, minHeight + height, normal)
      if (!profile.includeFacadeTrim && !profile.includeFacadeWindows) {
        continue
      }
      const floors = Math.max(1, Math.min(18, Math.floor(height / 3.2)))
      const windowColumns = Math.max(0, Math.min(28, Math.floor(length / 4.8)))
      const floorHeight = height / floors
      if (profile.includeFacadeTrim && length > 5.5 && floors > 2) {
        const bandInsetM = Math.min(0.45, length * 0.025)
        for (let floor = 1; floor < floors; floor += 1) {
          if (budget.facadeTrimBandsRemaining <= 0) break
          const y = minHeight + floor * floorHeight
          appendWallSpan(trimBucket, start, ux, uz, bandInsetM, length - bandInsetM, y - 0.028, y + 0.028, normal, facadeTrimReliefM)
          budget.facadeTrimBandsRemaining -= 1
        }
      }
      for (let floor = 0; floor < floors; floor += 1) {
        const floorBaseY = minHeight + floor * floorHeight
        const floorTopY = floor === floors - 1 ? minHeight + height : minHeight + (floor + 1) * floorHeight
        const y0 = floorBaseY
        const y1 = floorTopY
        if (windowColumns === 0 || !profile.includeFacadeWindows || budget.facadeWindowCellsRemaining <= 0) {
          continue
        }
        const facadeMarginM = Math.min(0.72, length * 0.045)
        const usableWidthM = Math.max(0, length - facadeMarginM * 2)
        for (let column = 0; column < windowColumns; column += 1) {
          const cellU0 = facadeMarginM + usableWidthM * column / windowColumns
          const cellU1 = facadeMarginM + usableWidthM * (column + 1) / windowColumns
          if (budget.facadeWindowCellsRemaining <= 0 || random() < 0.18) continue
          appendFacadeWindowCell(windowBucket, start, ux, uz, cellU0, cellU1, y0, y1, normal)
          budget.facadeWindowCellsRemaining -= 1
        }
      }
    }
  }
}

const appendRoofParapets = (
  bucket: MeshBucket,
  rings: ReadonlyArray<ReadonlyArray<LocalPoint>>,
  roofY: number,
  budget: SceneryDetailBudget,
): void => {
  if (budget.roofParapetSegmentsRemaining <= 0) return
  const outerRing = rings[0]
  if (!outerRing) return
  const ring = openRing(outerRing)
  if (ring.length < 2 || Math.abs(ringArea(ring)) < 85) return
  const ringSignedAreaM2 = ringArea(ring)
  for (let index = 0; index < ring.length && budget.roofParapetSegmentsRemaining > 0; index += 1) {
    const start = ring[index]!
    const end = ring[(index + 1) % ring.length]!
    const dx = end.x - start.x
    const dz = end.z - start.z
    const length = Math.hypot(dx, dz)
    if (length < 4.5) continue
    const ux = dx / length
    const uz = dz / length
    const normal = outwardWallNormal(dx, dz, length, ringSignedAreaM2)
    const insetM = Math.min(0.34, length * 0.06)
    appendWallSpan(bucket, start, ux, uz, insetM, length - insetM, roofY + 0.03, roofY + 0.52, normal, 0.04)
    budget.roofParapetSegmentsRemaining -= 1
  }
}

const roadPriority = (className: string): number => {
  if (className === 'motorway' || className === 'motorway_link') return 90
  if (className === 'trunk' || className === 'trunk_link') return 80
  if (className === 'primary') return 70
  if (className === 'secondary') return 60
  if (className === 'tertiary') return 50
  if (className === 'minor' || className === 'residential' || className === 'unclassified') return 40
  return 30
}

const simplifiedPath = (
  path: ReadonlyArray<LocalPoint>,
  minDistanceM: number,
): ReadonlyArray<LocalPoint> => {
  const first = path[0]
  const last = path[path.length - 1]
  if (!first || !last || path.length <= 2) return path
  const simplified: LocalPoint[] = [first]
  let previous = first
  for (const point of path.slice(1, -1)) {
    if (Math.hypot(point.x - previous.x, point.z - previous.z) < minDistanceM) continue
    simplified.push(point)
    previous = point
  }
  if (last !== simplified[simplified.length - 1]) simplified.push(last)
  return simplified
}

interface RibbonSegmentFrame {
  readonly start: LocalPoint
  readonly end: LocalPoint
  readonly length: number
  readonly ux: number
  readonly uz: number
  readonly nx: number
  readonly nz: number
}

const ribbonSegmentFrameFor = (
  start: LocalPoint,
  end: LocalPoint,
): RibbonSegmentFrame | null => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 0.05) return null
  const ux = dx / length
  const uz = dz / length
  return {
    start,
    end,
    length,
    ux,
    uz,
    nx: -uz,
    nz: ux,
  }
}

const ribbonJoinTrimM = (
  lengthM: number,
  halfWidthM: number,
): number => Math.min(halfWidthM * 2.4, lengthM * 0.46)

const appendRibbonSegmentQuad = (
  bucket: MeshBucket,
  frame: RibbonSegmentFrame,
  halfWidthM: number,
  startTrimM: number,
  endTrimM: number,
  y: number,
): void => {
  const start = {
    x: frame.start.x + frame.ux * startTrimM,
    z: frame.start.z + frame.uz * startTrimM,
  }
  const end = {
    x: frame.end.x - frame.ux * endTrimM,
    z: frame.end.z - frame.uz * endTrimM,
  }
  if (Math.hypot(end.x - start.x, end.z - start.z) < 0.05) return
  appendQuad(
    bucket,
    { x: start.x + frame.nx * halfWidthM, y, z: start.z + frame.nz * halfWidthM },
    { x: end.x + frame.nx * halfWidthM, y, z: end.z + frame.nz * halfWidthM },
    { x: end.x - frame.nx * halfWidthM, y, z: end.z - frame.nz * halfWidthM },
    { x: start.x - frame.nx * halfWidthM, y, z: start.z - frame.nz * halfWidthM },
    { x: 0, y: 1, z: 0 },
  )
}

const compactRibbonRing = (
  ring: ReadonlyArray<LocalPoint>,
): ReadonlyArray<LocalPoint> => {
  const compact: LocalPoint[] = []
  for (const point of ring) {
    const previous = compact[compact.length - 1]
    if (previous && Math.hypot(previous.x - point.x, previous.z - point.z) < 0.01) continue
    compact.push(point)
  }
  const first = compact[0]
  const last = compact[compact.length - 1]
  if (first && last && compact.length > 1 && Math.hypot(first.x - last.x, first.z - last.z) < 0.01) compact.pop()
  return compact
}

const appendRibbonRoundJoin = (
  bucket: MeshBucket,
  center: LocalPoint,
  halfWidthM: number,
  y: number,
): void => {
  const segmentCount = Math.max(10, Math.min(24, Math.ceil(halfWidthM * 1.2)))
  const ring = compactRibbonRing(Array.from({ length: segmentCount }, (_value, index) => {
    const angle = index / segmentCount * Math.PI * 2
    return {
      x: center.x + Math.cos(angle) * halfWidthM,
      z: center.z + Math.sin(angle) * halfWidthM,
    }
  }))
  if (ring.length < 3 || Math.abs(ringArea(ring)) < 0.005) return
  appendHorizontalPolygon(bucket, [ring], y)
}

const appendRibbon = (
  bucket: MeshBucket,
  path: ReadonlyArray<LocalPoint>,
  widthM: number,
  y: number,
  simplifyDistanceM = 0.35,
  joinLiftM = 0,
): void => {
  const points = simplifiedPath(path, simplifyDistanceM)
  if (points.length < 2) return
  const halfWidth = widthM / 2
  const frames = points
    .slice(0, -1)
    .flatMap((point, index) => {
      const frame = ribbonSegmentFrameFor(point, points[index + 1]!)
      return frame ? [frame] : []
    })
  if (frames.length === 0) return
  const startTrims = frames.map((frame, index) => index === 0
    ? 0
    : Math.min(ribbonJoinTrimM(frame.length, halfWidth), ribbonJoinTrimM(frames[index - 1]!.length, halfWidth)))
  const endTrims = frames.map((frame, index) => index === frames.length - 1
    ? 0
    : Math.min(ribbonJoinTrimM(frame.length, halfWidth), ribbonJoinTrimM(frames[index + 1]!.length, halfWidth)))
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!
    const requestedTrimM = startTrims[index]! + endTrims[index]!
    if (requestedTrimM > frame.length - 0.05) {
      const scale = Math.max(0, frame.length - 0.05) / requestedTrimM
      startTrims[index] = startTrims[index]! * scale
      endTrims[index] = endTrims[index]! * scale
    }
    appendRibbonSegmentQuad(bucket, frame, halfWidth, startTrims[index]!, endTrims[index]!, y)
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = frames[index - 1]
    const next = frames[index]
    if (!previous || !next) continue
    appendRibbonRoundJoin(bucket, points[index]!, halfWidth, y + joinLiftM)
  }
}

const appendDash = (
  bucket: MeshBucket,
  center: LocalPoint,
  ux: number,
  uz: number,
  halfLength: number,
  halfWidth: number,
  y: number,
): void => {
  const nx = -uz
  const nz = ux
  appendQuad(
    bucket,
    { x: center.x + ux * halfLength + nx * halfWidth, y, z: center.z + uz * halfLength + nz * halfWidth },
    { x: center.x + ux * halfLength - nx * halfWidth, y, z: center.z + uz * halfLength - nz * halfWidth },
    { x: center.x - ux * halfLength - nx * halfWidth, y, z: center.z - uz * halfLength - nz * halfWidth },
    { x: center.x - ux * halfLength + nx * halfWidth, y, z: center.z - uz * halfLength + nz * halfWidth },
    { x: 0, y: 1, z: 0 },
  )
}

const appendRoadMarkings = (
  bucket: MeshBucket,
  path: ReadonlyArray<LocalPoint>,
  lineId: string,
  widthM: number,
  y: number,
  budget: SceneryDetailBudget,
): void => {
  if (widthM < 8 || budget.roadMarkingDashesRemaining <= 0) return
  const dashOffset = 6 + stableHash(lineId) % 13
  let dashCount = 0
  for (let index = 0; index < path.length - 1 && dashCount < 96 && budget.roadMarkingDashesRemaining > 0; index += 1) {
    const start = path[index]!
    const end = path[index + 1]!
    const dx = end.x - start.x
    const dz = end.z - start.z
    const length = Math.hypot(dx, dz)
    if (length < 20) continue
    const ux = dx / length
    const uz = dz / length
    for (let distance = dashOffset; distance < length - 5 && dashCount < 96 && budget.roadMarkingDashesRemaining > 0; distance += 31) {
      appendDash(bucket, { x: start.x + ux * distance, z: start.z + uz * distance }, ux, uz, 4.4, 0.22, y)
      dashCount += 1
      budget.roadMarkingDashesRemaining -= 1
    }
  }
}

const offsetPath = (
  path: ReadonlyArray<LocalPoint>,
  offsetM: number,
): ReadonlyArray<LocalPoint> =>
  path.map((point, index) => {
    const previous = path[index - 1]
    const next = path[index + 1]
    const from = previous ?? point
    const to = next ?? point
    const dx = to.x - from.x
    const dz = to.z - from.z
    const length = Math.max(0.001, Math.hypot(dx, dz))
    const nx = -dz / length
    const nz = dx / length
    return { x: point.x + nx * offsetM, z: point.z + nz * offsetM }
  })

const appendRoadEdgeMarkings = (
  bucket: MeshBucket,
  path: ReadonlyArray<LocalPoint>,
  widthM: number,
  y: number,
  budget: SceneryDetailBudget,
): void => {
  if (widthM < 10 || budget.roadEdgeRibbonPairsRemaining <= 0) return
  budget.roadEdgeRibbonPairsRemaining -= 1
  const offset = Math.max(2.8, widthM * 0.42)
  appendRibbon(bucket, offsetPath(path, -offset), 0.18, y)
  appendRibbon(bucket, offsetPath(path, offset), 0.18, y)
}

interface RoadLaneShape {
  readonly id: string
  readonly path: ReadonlyArray<LocalPoint>
  readonly widthM: number
  readonly deckY: number
  readonly priority: number
}

interface AssignedRoadLaneShape extends RoadLaneShape {
  readonly lane: number
}

const priorityLiftForRoad = (priority: number): number =>
  priority >= 70 ? 0.08 : priority >= 60 ? 0.04 : 0

const boundsForPath = (
  path: ReadonlyArray<LocalPoint>,
  paddingM: number,
): { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number } => {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const point of path) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }
  return {
    minX: minX - paddingM,
    maxX: maxX + paddingM,
    minZ: minZ - paddingM,
    maxZ: maxZ + paddingM,
  }
}

const boundsOverlap = (
  left: ReturnType<typeof boundsForPath>,
  right: ReturnType<typeof boundsForPath>,
): boolean =>
  left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minZ <= right.maxZ
    && left.maxZ >= right.minZ

const pointSegmentDistanceM = (
  point: LocalPoint,
  start: LocalPoint,
  end: LocalPoint,
): number => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.z - start.z)
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared))
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t))
}

const segmentsIntersect = (
  a0: LocalPoint,
  a1: LocalPoint,
  b0: LocalPoint,
  b1: LocalPoint,
): boolean => {
  const epsilon = 0.000001
  const cross = (p0: LocalPoint, p1: LocalPoint, p2: LocalPoint): number =>
    (p1.x - p0.x) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.x - p0.x)
  const onSegment = (point: LocalPoint, start: LocalPoint, end: LocalPoint): boolean =>
    point.x >= Math.min(start.x, end.x) - epsilon
      && point.x <= Math.max(start.x, end.x) + epsilon
      && point.z >= Math.min(start.z, end.z) - epsilon
      && point.z <= Math.max(start.z, end.z) + epsilon
  const d1 = cross(a0, a1, b0)
  const d2 = cross(a0, a1, b1)
  const d3 = cross(b0, b1, a0)
  const d4 = cross(b0, b1, a1)
  if (Math.abs(d1) <= epsilon && onSegment(b0, a0, a1)) return true
  if (Math.abs(d2) <= epsilon && onSegment(b1, a0, a1)) return true
  if (Math.abs(d3) <= epsilon && onSegment(a0, b0, b1)) return true
  if (Math.abs(d4) <= epsilon && onSegment(a1, b0, b1)) return true
  return d1 * d2 < 0 && d3 * d4 < 0
}

const segmentDistanceM = (
  a0: LocalPoint,
  a1: LocalPoint,
  b0: LocalPoint,
  b1: LocalPoint,
): number =>
  segmentsIntersect(a0, a1, b0, b1)
    ? 0
    : Math.min(
        pointSegmentDistanceM(a0, b0, b1),
        pointSegmentDistanceM(a1, b0, b1),
        pointSegmentDistanceM(b0, a0, a1),
        pointSegmentDistanceM(b1, a0, a1),
      )

const roadsOverlapOnDeck = (
  left: RoadLaneShape,
  right: RoadLaneShape,
): boolean => {
  if (Math.abs(left.deckY - right.deckY) >= horizontalDepth.roadFeatureLaneStepM) return false
  const overlapDistanceM = (left.widthM + right.widthM) / 2 + 1.5
  if (!boundsOverlap(boundsForPath(left.path, overlapDistanceM), boundsForPath(right.path, overlapDistanceM))) return false
  for (let leftIndex = 0; leftIndex < left.path.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.path.length - 1; rightIndex += 1) {
      if (segmentDistanceM(left.path[leftIndex]!, left.path[leftIndex + 1]!, right.path[rightIndex]!, right.path[rightIndex + 1]!) <= overlapDistanceM) {
        return true
      }
    }
  }
  return false
}

const roadLaneAssignmentsFor = (
  tile: SceneryTile,
  center: TileLonLat,
  profile: SceneryGlbLodProfile,
): ReadonlyMap<string, number> => {
  const candidates = tile.features.lines.flatMap(feature => {
    if (feature.kind !== 'road') return []
    const priority = roadPriority(feature.className)
    if (priority < profile.minRoadPriority) return []
    const path = feature.path.map(point => localPointFromSceneryPoint(point, tile.tile, center))
    if (path.length < 2) return []
    return [{
      id: feature.id,
      path,
      widthM: feature.widthM,
      deckY: feature.verticalOffsetM + priorityLiftForRoad(priority),
      priority,
    }]
  }).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
  const assigned: AssignedRoadLaneShape[] = []
  const lanes = new Map<string, number>()
  for (const candidate of candidates) {
    let lane = 0
    while (assigned.some(existing => existing.lane === lane && roadsOverlapOnDeck(candidate, existing))) lane += 1
    lanes.set(candidate.id, lane)
    assigned.push({ ...candidate, lane })
  }
  return lanes
}

const roadDepthLaneY = (
  feature: SceneryTile['features']['lines'][number],
  priority: number,
  lane: number,
): number => {
  return horizontalDepth.roadBaseY
    + feature.verticalOffsetM
    + priorityLiftForRoad(priority)
    + lane * horizontalDepth.roadFeatureLaneStepM
}

const appendRibbonSideBands = (
  bucket: MeshBucket,
  path: ReadonlyArray<LocalPoint>,
  innerWidthM: number,
  outerWidthM: number,
  y: number,
  simplifyDistanceM: number,
  joinLiftM = 0,
): void => {
  const bandWidthM = (outerWidthM - innerWidthM) / 2
  if (bandWidthM < 0.08) return
  const offsetM = innerWidthM / 2 + bandWidthM / 2
  appendRibbon(bucket, offsetPath(path, -offsetM), bandWidthM, y, simplifyDistanceM, joinLiftM)
  appendRibbon(bucket, offsetPath(path, offsetM), bandWidthM, y, simplifyDistanceM, joinLiftM)
}

const appendCylinder = (
  bucket: MeshBucket,
  center: Vec3,
  radius: number,
  height: number,
  segments: number,
): void => {
  const bottomY = center.y - height / 2
  const topY = center.y + height / 2
  for (let index = 0; index < segments; index += 1) {
    const a0 = index / segments * Math.PI * 2
    const a1 = (index + 1) / segments * Math.PI * 2
    const p0 = { x: center.x + Math.cos(a0) * radius, z: center.z + Math.sin(a0) * radius }
    const p1 = { x: center.x + Math.cos(a1) * radius, z: center.z + Math.sin(a1) * radius }
    const normal = { x: Math.cos((a0 + a1) / 2), y: 0, z: Math.sin((a0 + a1) / 2) }
    appendQuad(
      bucket,
      { x: p0.x, y: bottomY, z: p0.z },
      { x: p1.x, y: bottomY, z: p1.z },
      { x: p1.x, y: topY, z: p1.z },
      { x: p0.x, y: topY, z: p0.z },
      normal,
    )
  }
}

const appendCone = (
  bucket: MeshBucket,
  center: Vec3,
  radius: number,
  height: number,
  segments: number,
): void => {
  const baseY = center.y - height / 2
  const top = { x: center.x, y: center.y + height / 2, z: center.z }
  for (let index = 0; index < segments; index += 1) {
    const a0 = index / segments * Math.PI * 2
    const a1 = (index + 1) / segments * Math.PI * 2
    const p0 = { x: center.x + Math.cos(a0) * radius, y: baseY, z: center.z + Math.sin(a0) * radius }
    const p1 = { x: center.x + Math.cos(a1) * radius, y: baseY, z: center.z + Math.sin(a1) * radius }
    const normal = { x: Math.cos((a0 + a1) / 2), y: radius / Math.max(0.1, height), z: Math.sin((a0 + a1) / 2) }
    const base = bucket.positions.length / 3
    appendVertex(bucket, p0, normal)
    appendVertex(bucket, p1, normal)
    appendVertex(bucket, top, normal)
    bucket.indices.push(base, base + 1, base + 2)
  }
}

const appendBox = (
  bucket: MeshBucket,
  center: Vec3,
  size: Vec3,
): void => {
  const hx = size.x / 2
  const hy = size.y / 2
  const hz = size.z / 2
  const x0 = center.x - hx
  const x1 = center.x + hx
  const y0 = center.y - hy
  const y1 = center.y + hy
  const z0 = center.z - hz
  const z1 = center.z + hz
  appendQuad(bucket, { x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }, { x: 0, y: 0, z: 1 })
  appendQuad(bucket, { x: x1, y: y0, z: z0 }, { x: x0, y: y0, z: z0 }, { x: x0, y: y1, z: z0 }, { x: x1, y: y1, z: z0 }, { x: 0, y: 0, z: -1 })
  appendQuad(bucket, { x: x1, y: y0, z: z1 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }, { x: 1, y: 0, z: 0 })
  appendQuad(bucket, { x: x0, y: y0, z: z0 }, { x: x0, y: y0, z: z1 }, { x: x0, y: y1, z: z1 }, { x: x0, y: y1, z: z0 }, { x: -1, y: 0, z: 0 })
  appendQuad(bucket, { x: x0, y: y1, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 }, { x: 0, y: 1, z: 0 })
  appendQuad(bucket, { x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y0, z: z1 }, { x: x0, y: y0, z: z1 }, { x: 0, y: -1, z: 0 })
}

const appendRoofFixtures = (
  bucket: MeshBucket,
  rings: ReadonlyArray<ReadonlyArray<LocalPoint>>,
  roofY: number,
  seed: number,
  budget: SceneryDetailBudget,
): void => {
  if (budget.roofFixturesRemaining <= 0) return
  const outer = rings[0]
  if (!outer || outer.length < 3) return
  const area = Math.abs(ringArea(outer))
  if (area < 65) return
  const random = seededRandom(seed)
  const center = polygonCentroid(outer)
  const fixtureCount = Math.max(1, Math.min(4, budget.roofFixturesRemaining, Math.floor(area / 2_700)))
  for (let index = 0; index < fixtureCount && budget.roofFixturesRemaining > 0; index += 1) {
    const angle = random() * Math.PI * 2
    const distance = index === 0 ? 0 : Math.min(7, Math.sqrt(area) * 0.08) * random()
    const x = center.x + Math.cos(angle) * distance
    const z = center.z + Math.sin(angle) * distance
    if (!pointInRing({ x, z }, outer)) continue
    const width = 1.7 + random() * 3.4
    const depth = 1.4 + random() * 2.6
    const height = 0.45 + random() * 1.3
    appendBox(bucket, { x, y: roofY + height / 2 + 0.08, z }, { x: width, y: height, z: depth })
    budget.roofFixturesRemaining -= 1
  }
}

const surfaceMaterialFor = (kind: string, className: string): string => {
  if (kind === 'water') return 'water'
  if (className === 'wood' || className === 'forest') return 'ground-wood'
  if (className === 'park' || className === 'grass') return 'ground-park'
  if (className === 'farmland' || className === 'farmyard') return 'ground-field'
  if (className === 'wetland') return 'ground-wetland'
  if (className === 'commercial' || className === 'industrial' || className === 'residential') return 'ground-urban'
  return 'ground-grass'
}

const baseSurfaceHeightByMaterialKey: Readonly<Record<string, number>> = {
  'ground-grass': horizontalDepth.landcoverBaseY,
  'ground-park': horizontalDepth.landuseBaseY,
  'ground-field': 0.30,
  'ground-wetland': horizontalDepth.wetlandBaseY,
  'ground-urban': horizontalDepth.urbanBaseY,
  'ground-wood': horizontalDepth.woodlandBaseY,
  water: horizontalDepth.waterSurfaceY,
  'road-shoulder': horizontalDepth.aerowaySurfaceY,
}

const surfaceHeightForFeature = (
  feature: SceneryTile['features']['polygons'][number],
  materialKey: string,
): number => {
  if (feature.kind === 'water') return horizontalDepth.waterSurfaceY
  if (feature.kind === 'aeroway') return horizontalDepth.aerowaySurfaceY
  return baseSurfaceHeightByMaterialKey[materialKey] ?? horizontalDepth.landcoverBaseY
}

const buildingWallMaterialFor = (
  feature: SceneryTile['features']['polygons'][number],
): string => {
  if (feature.className === 'commercial') return stableHash(`wall-commercial:${feature.id}`) % 4 === 0 ? 'building-wall-dark' : 'building-wall-cool'
  if (feature.className === 'industrial') return stableHash(`wall-industrial:${feature.id}`) % 3 === 0 ? 'building-wall-dark' : 'building-wall-cool'
  const bucket = stableHash(`wall:${feature.id}`) % 8
  if (bucket === 0) return 'building-wall-brick'
  if (bucket === 1) return 'building-wall-stone'
  if (bucket === 2) return 'building-wall-warm'
  if (bucket === 3) return 'building-wall-cool'
  return 'building-wall'
}

const buildingRoofMaterialFor = (
  feature: SceneryTile['features']['polygons'][number],
): string => {
  const bucket = stableHash(`roof:${feature.id}`) % 12
  if (bucket === 0) return 'building-roof-green'
  if (bucket === 1 || bucket === 2) return 'building-roof-red'
  if (bucket === 3 || bucket === 4) return 'building-roof-dark'
  if (bucket <= 7) return 'building-roof-light'
  return 'building-roof'
}

const buildingRoofMaterialLiftM = (
  materialKey: string,
): number => {
  const order = [
    'building-roof',
    'building-roof-light',
    'building-roof-green',
    'building-roof-red',
    'building-roof-dark',
  ]
  return Math.max(0, order.indexOf(materialKey)) * horizontalDepth.roofMaterialLiftStepM
}

const localRingsFor = (
  rings: ReadonlyArray<ReadonlyArray<SceneryPoint>>,
  tile: SceneryTile['tile'],
  center: TileLonLat,
): ReadonlyArray<ReadonlyArray<LocalPoint>> =>
  rings
    .map(ring => ring.map(point => localPointFromSceneryPoint(point, tile, center)))
    .filter(ring => ring.length >= 3)

const appendSurfaces = (
  buckets: Map<string, MeshBucket>,
  tile: SceneryTile,
  center: TileLonLat,
): void => {
  for (const feature of tile.features.polygons) {
    if (feature.kind === 'building') continue
    const material = surfaceMaterialFor(feature.kind, feature.className)
    const bucket = bucketFor(buckets, material, `${material} surfaces`)
    appendHorizontalPolygon(bucket, localRingsFor(feature.rings, tile.tile, center), surfaceHeightForFeature(feature, material))
  }
}

const appendBuildings = (
  buckets: Map<string, MeshBucket>,
  tile: SceneryTile,
  center: TileLonLat,
  profile: SceneryGlbLodProfile,
  budget: SceneryDetailBudget,
): void => {
  const windows = bucketFor(buckets, 'building-window', 'building facade windows')
  const trim = bucketFor(buckets, 'building-trim', 'building facade trim')
  const roofParapets = bucketFor(buckets, 'roof-parapet', 'roof edge parapets')
  const roofFixtures = bucketFor(buckets, 'roof-fixture', 'roof-mounted source-backed fixtures')
  for (const feature of tile.features.polygons) {
    if (feature.kind !== 'building') continue
    const rings = localRingsFor(feature.rings, tile.tile, center)
    if (rings.length === 0) continue
    const outerRing = rings[0]
    if (outerRing && Math.abs(ringArea(outerRing)) < profile.minBuildingAreaM2) continue
    const height = Math.max(2.5, feature.heightM ?? 8)
    const minHeight = Math.max(0, feature.minHeightM ?? 0)
    const wallBucket = bucketFor(buckets, buildingWallMaterialFor(feature), `${buildingWallMaterialFor(feature)} shells`)
    const roofMaterial = buildingRoofMaterialFor(feature)
    const roofBucket = bucketFor(buckets, roofMaterial, `${roofMaterial} shells`)
    const roofY = minHeight + height + 0.08 + buildingRoofMaterialLiftM(roofMaterial)
    appendBuildingWalls(wallBucket, windows, trim, rings, minHeight, height, stableHash(feature.id), profile, budget)
    appendHorizontalPolygon(roofBucket, rings, roofY)
    if (profile.includeRoofParapets) {
      appendRoofParapets(roofParapets, rings, roofY, budget)
    }
    if (profile.includeRoofFixtures) {
      appendRoofFixtures(roofFixtures, rings, roofY + 0.08, stableHash(`fixture:${feature.id}`), budget)
    }
  }
}

const appendTransport = (
  buckets: Map<string, MeshBucket>,
  tile: SceneryTile,
  center: TileLonLat,
  profile: SceneryGlbLodProfile,
  budget: SceneryDetailBudget,
): void => {
  const shoulder = bucketFor(buckets, 'road-shoulder', 'road shoulders')
  const casing = bucketFor(buckets, 'road-casing', 'road casings')
  const fill = bucketFor(buckets, 'road-fill', 'road fills')
  const majorFill = bucketFor(buckets, 'road-major-fill', 'major road fills')
  const markings = bucketFor(buckets, 'road-marking', 'baked road markings')
  const rail = bucketFor(buckets, 'rail', 'rails')
  const water = bucketFor(buckets, 'water', 'waterways')
  const poles = bucketFor(buckets, 'street-light', 'street light poles')
  const lamps = bucketFor(buckets, 'street-lamp', 'street lamps')
  const roadLaneByFeatureId = roadLaneAssignmentsFor(tile, center, profile)
  for (const feature of tile.features.lines) {
    const path = feature.path.map(point => localPointFromSceneryPoint(point, tile.tile, center))
    if (path.length < 2) continue
    if (feature.kind === 'waterway') {
      const waterwayY = horizontalDepth.waterwayY + feature.verticalOffsetM
      appendRibbon(water, path, feature.widthM, waterwayY, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
      continue
    }
    if (feature.kind === 'rail') {
      appendRibbon(casing, path, feature.widthM + 3.2, horizontalDepth.railCasingY + feature.verticalOffsetM, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
      appendRibbon(rail, path, feature.widthM, horizontalDepth.railSteelY + feature.verticalOffsetM, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
      continue
    }
    if (feature.kind === 'aeroway') {
      appendRibbon(shoulder, path, feature.widthM + 4, horizontalDepth.aerowayShoulderY + feature.verticalOffsetM, profile.lineSimplifyDistanceM)
      appendRibbon(fill, path, feature.widthM, horizontalDepth.aerowayFillY + feature.verticalOffsetM, profile.lineSimplifyDistanceM)
      continue
    }
    const priority = roadPriority(feature.className)
    if (priority < profile.minRoadPriority) continue
    const roadY = roadDepthLaneY(feature, priority, roadLaneByFeatureId.get(feature.id) ?? 0)
    const casingOuterWidthM = feature.widthM + Math.max(3.5, feature.widthM * 0.16)
    const shoulderOuterWidthM = feature.widthM + Math.max(6.5, feature.widthM * 0.28)
    appendRibbonSideBands(shoulder, path, casingOuterWidthM, shoulderOuterWidthM, roadY, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
    appendRibbonSideBands(casing, path, feature.widthM, casingOuterWidthM, roadY + horizontalDepth.roadCasingLiftM, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
    appendRibbon(priority >= 60 ? majorFill : fill, path, feature.widthM, roadY + horizontalDepth.roadFillLiftM, profile.lineSimplifyDistanceM, ribbonJoinLiftM)
    if (profile.includeRoadMarkings) {
      appendRoadEdgeMarkings(markings, path, feature.widthM, roadY + horizontalDepth.roadEdgeMarkingLiftM, budget)
      appendRoadMarkings(markings, path, feature.id, feature.widthM, roadY + horizontalDepth.roadCenterMarkingLiftM, budget)
    }
    if (!profile.includeStreetLights || priority < 40 || feature.isTunnel || budget.streetLightsRemaining <= 0) continue
    let distance = 20 + stableHash(`lamp:${feature.id}`) % 38
    for (let index = 0; index < path.length - 1; index += 1) {
      const start = path[index]!
      const end = path[index + 1]!
      const dx = end.x - start.x
      const dz = end.z - start.z
      const length = Math.hypot(dx, dz)
      if (length < 18) continue
      const ux = dx / length
      const uz = dz / length
      const nx = -uz
      const nz = ux
      while (distance < length && budget.streetLightsRemaining > 0) {
        for (const side of [-1, 1] as const) {
          if (budget.streetLightsRemaining <= 0) break
          const offset = side * Math.max(4.5, feature.widthM * 0.5 + 2.4)
          const x = start.x + ux * distance + nx * offset
          const z = start.z + uz * distance + nz * offset
          appendCylinder(poles, { x, y: 3.1 + feature.verticalOffsetM, z }, 0.09, 6.2, 7)
          appendBox(lamps, { x: x + nx * -side * 0.3, y: 6.34 + feature.verticalOffsetM, z: z + nz * -side * 0.3 }, { x: 0.45, y: 0.16, z: 0.9 })
          budget.streetLightsRemaining -= 1
        }
        distance += priority >= 70 ? 84 : 112
      }
      distance -= length
    }
  }
}

const appendVegetation = (
  buckets: Map<string, MeshBucket>,
  tile: SceneryTile,
  center: TileLonLat,
  profile: SceneryGlbLodProfile,
): void => {
  if (profile.vegetationMaxPerTile <= 0) return
  const trunk = bucketFor(buckets, 'tree-trunk', 'tree trunks')
  const canopy = bucketFor(buckets, 'tree-canopy', 'tree canopies')
  const canopyLight = bucketFor(buckets, 'tree-canopy-light', 'tree canopy highlights')
  let treeCount = 0
  for (const feature of tile.features.polygons) {
    if (feature.kind !== 'landcover' && feature.kind !== 'landuse') continue
    if (!['wood', 'forest', 'scrub', 'heath', 'grass', 'park', 'residential'].includes(feature.className)) continue
    const rings = localRingsFor(feature.rings, tile.tile, center)
    const outer = rings[0]
    if (!outer || outer.length < 3) continue
    const area = Math.abs(ringArea(outer))
    const areaPerTree = feature.className === 'residential'
      ? profile.vegetationResidentialAreaM2
      : profile.vegetationNaturalAreaM2
    const remainingTreeBudget = profile.vegetationMaxPerTile - treeCount
    if (remainingTreeBudget <= 0) return
    const targetCount = Math.max(1, Math.min(24, remainingTreeBudget, Math.floor(area / areaPerTree)))
    const bounds = boundsForRing(outer)
    const random = seededRandom(stableHash(`veg:${feature.id}`))
    let added = 0
    for (let attempt = 0; attempt < targetCount * 10 && added < targetCount && treeCount < profile.vegetationMaxPerTile; attempt += 1) {
      const candidate = attempt === 0
        ? polygonCentroid(outer)
        : {
            x: bounds.minX + random() * (bounds.maxX - bounds.minX),
            z: bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
          }
      if (!pointInRing(candidate, outer)) continue
      const scale = 0.75 + random() * 0.85
      appendCylinder(trunk, { x: candidate.x, y: 2.1 * scale, z: candidate.z }, 0.34 * scale, 4.2 * scale, 6)
      appendCone(canopy, { x: candidate.x, y: 6.0 * scale, z: candidate.z }, 2.45 * scale, 5.2 * scale, 8)
      appendCone(canopyLight, { x: candidate.x + 0.45 * scale, y: 8.8 * scale, z: candidate.z - 0.25 * scale }, 1.75 * scale, 3.7 * scale, 8)
      added += 1
      treeCount += 1
    }
  }
}

const appendPoiBeacons = (
  buckets: Map<string, MeshBucket>,
  tile: SceneryTile,
  center: TileLonLat,
  profile: SceneryGlbLodProfile,
  budget: SceneryDetailBudget,
): void => {
  if (!profile.includePoiBeacons || budget.poiBeaconsRemaining <= 0) return
  const poi = bucketFor(buckets, 'poi', 'poi beacons')
  for (const feature of tile.features.labels) {
    if (budget.poiBeaconsRemaining <= 0) break
    if (feature.kind === 'road_label') continue
    const point = localPointFromSceneryPoint(feature.point, tile.tile, center)
    appendCylinder(poi, { x: point.x, y: 4.5, z: point.z }, 0.22, 9, 8)
    appendCone(poi, { x: point.x, y: 10.5, z: point.z }, 1.2, 2.2, 12)
    budget.poiBeaconsRemaining -= 1
  }
}

const primitivesFromBuckets = (
  buckets: ReadonlyMap<string, MeshBucket>,
): ReadonlyArray<PrimitiveSpec> =>
  [...buckets.values()]
    .filter(bucket => bucket.positions.length > 0 && bucket.indices.length > 0)
    .map(bucket => ({
      name: bucket.name,
      materialKey: bucket.materialKey,
      positions: new Float32Array(bucket.positions),
      normals: new Float32Array(bucket.normals),
      indices: new Uint32Array(bucket.indices),
    }))

const align4 = (value: number): number =>
  (value + 3) & ~3

const appendBytes = (
  chunks: Uint8Array[],
  bytes: Uint8Array,
): number => {
  const offset = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  chunks.push(bytes)
  const padding = align4(offset + bytes.byteLength) - (offset + bytes.byteLength)
  if (padding > 0) chunks.push(new Uint8Array(padding))
  return offset
}

const bytesForFloat32 = (values: Float32Array): Uint8Array =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength)

const bytesForUint32 = (values: Uint32Array): Uint8Array =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength)

const minMaxForPositions = (
  positions: Float32Array,
): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0
    const y = positions[index + 1] ?? 0
    const z = positions[index + 2] ?? 0
    min[0] = Math.min(min[0], x)
    min[1] = Math.min(min[1], y)
    min[2] = Math.min(min[2], z)
    max[0] = Math.max(max[0], x)
    max[1] = Math.max(max[1], y)
    max[2] = Math.max(max[2], z)
  }
  return { min, max }
}

const primitiveBounds = (
  primitives: ReadonlyArray<PrimitiveSpec>,
): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const primitive of primitives) {
    const bounds = minMaxForPositions(primitive.positions)
    min[0] = Math.min(min[0], bounds.min[0])
    min[1] = Math.min(min[1], bounds.min[1])
    min[2] = Math.min(min[2], bounds.min[2])
    max[0] = Math.max(max[0], bounds.max[0])
    max[1] = Math.max(max[1], bounds.max[1])
    max[2] = Math.max(max[2], bounds.max[2])
  }
  return Number.isFinite(min[0])
    ? { min, max }
    : { min: [0, 0, 0], max: [0, 0, 0] }
}

interface HorizontalPlaneSample {
  readonly id: number
  readonly materialKey: string
  readonly y: number
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly points: readonly [HorizontalTrianglePoint, HorizontalTrianglePoint, HorizontalTrianglePoint]
}

interface HorizontalTrianglePoint {
  readonly x: number
  readonly z: number
}

interface HorizontalOverlapMaterialPairSummary {
  readonly materialKey: string
  readonly count: number
  readonly minGapM: number
}

const horizontalPlaneYToleranceM = 0.003
const horizontalOverlapGapWarningM = 0.05
const horizontalOverlapAreaWarningM2 = 0.16
const horizontalOverlapGridM = 48
const degenerateTriangleAreaM2 = 0.0005
const tilePointBoundsEpsilon = 0.001

const allFeaturePoints = (
  tile: SceneryTile,
): ReadonlyArray<SceneryPoint> => [
  ...tile.features.polygons.flatMap(feature => feature.rings.flatMap(ring => ring)),
  ...tile.features.lines.flatMap(feature => feature.path),
]

const outOfBoundsPointCountFor = (
  tile: SceneryTile,
): number => allFeaturePoints(tile).filter(point =>
  point[0] < -tilePointBoundsEpsilon
    || point[0] > tile.tile.extent + tilePointBoundsEpsilon
    || point[1] < -tilePointBoundsEpsilon
    || point[1] > tile.tile.extent + tilePointBoundsEpsilon,
).length

const duplicateSourceRefCountFor = (
  tile: SceneryTile,
): number => {
  const counts = new Map<string, number>()
  const note = (kind: string, sourceLayer: string, sourceRef: string | undefined): void => {
    if (!sourceRef) return
    const key = `${kind}:${sourceLayer}:${sourceRef}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const feature of tile.features.polygons) note(feature.kind, feature.sourceLayer, feature.sourceRef)
  for (const feature of tile.features.lines) note(feature.kind, feature.sourceLayer, feature.sourceRef)
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
}

const triangleAreaM2 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): number => {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const acx = c[0] - a[0]
  const acy = c[1] - a[1]
  const acz = c[2] - a[2]
  const cx = aby * acz - abz * acy
  const cy = abz * acx - abx * acz
  const cz = abx * acy - aby * acx
  return Math.hypot(cx, cy, cz) / 2
}

const positionAt = (
  positions: Float32Array,
  index: number,
): readonly [number, number, number] => [
  positions[index * 3] ?? 0,
  positions[index * 3 + 1] ?? 0,
  positions[index * 3 + 2] ?? 0,
]

const horizontalSampleFor = (
  id: number,
  primitive: PrimitiveSpec,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): HorizontalPlaneSample | null => {
  const minY = Math.min(a[1], b[1], c[1])
  const maxY = Math.max(a[1], b[1], c[1])
  if (maxY - minY > horizontalPlaneYToleranceM) return null
  return {
    id,
    materialKey: primitive.materialKey,
    y: (a[1] + b[1] + c[1]) / 3,
    minX: Math.min(a[0], b[0], c[0]),
    maxX: Math.max(a[0], b[0], c[0]),
    minZ: Math.min(a[2], b[2], c[2]),
    maxZ: Math.max(a[2], b[2], c[2]),
    points: [
      { x: a[0], z: a[2] },
      { x: b[0], z: b[2] },
      { x: c[0], z: c[2] },
    ],
  }
}

const quantizedPositionKey = (
  position: readonly [number, number, number],
): string => [
  Math.round(position[0] * 1000),
  Math.round(position[1] * 1000),
  Math.round(position[2] * 1000),
].join(':')

const horizontalTriangleSignatureFor = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): string => [
  quantizedPositionKey(a),
  quantizedPositionKey(b),
  quantizedPositionKey(c),
].sort().join('|')

const horizontalSamplesFor = (
  primitives: ReadonlyArray<PrimitiveSpec>,
): {
  readonly samples: ReadonlyArray<HorizontalPlaneSample>
  readonly degenerateTriangleCount: number
  readonly duplicateHorizontalTriangleCount: number
  readonly triangleCount: number
  readonly vertexCount: number
} => {
  const samples: HorizontalPlaneSample[] = []
  const horizontalTriangleSignatures = new Set<string>()
  let sampleId = 0
  let triangleCount = 0
  let vertexCount = 0
  let degenerateTriangleCount = 0
  let duplicateHorizontalTriangleCount = 0
  for (const primitive of primitives) {
    vertexCount += primitive.positions.length / 3
    for (let index = 0; index < primitive.indices.length; index += 3) {
      const aIndex = primitive.indices[index]
      const bIndex = primitive.indices[index + 1]
      const cIndex = primitive.indices[index + 2]
      if (aIndex === undefined || bIndex === undefined || cIndex === undefined) continue
      triangleCount += 1
      const a = positionAt(primitive.positions, aIndex)
      const b = positionAt(primitive.positions, bIndex)
      const c = positionAt(primitive.positions, cIndex)
      if (triangleAreaM2(a, b, c) < degenerateTriangleAreaM2) degenerateTriangleCount += 1
      const sample = horizontalSampleFor(sampleId, primitive, a, b, c)
      sampleId += 1
      if (sample) {
        const signature = horizontalTriangleSignatureFor(a, b, c)
        if (horizontalTriangleSignatures.has(signature)) duplicateHorizontalTriangleCount += 1
        horizontalTriangleSignatures.add(signature)
        samples.push(sample)
      }
    }
  }
  return { samples, degenerateTriangleCount, duplicateHorizontalTriangleCount, triangleCount, vertexCount }
}

const horizontalOverlapAreaM2 = (
  left: HorizontalPlaneSample,
  right: HorizontalPlaneSample,
): number => {
  const widthM = Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX)
  const depthM = Math.min(left.maxZ, right.maxZ) - Math.max(left.minZ, right.minZ)
  if (widthM <= 0 || depthM <= 0) return 0
  return convexPolygonOverlapAreaM2(left.points, right.points)
}

const signedPolygonAreaM2 = (
  points: ReadonlyArray<HorizontalTrianglePoint>,
): number => {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    area += current.x * next.z - next.x * current.z
  }
  return area / 2
}

const pointInsideClipEdge = (
  point: HorizontalTrianglePoint,
  edgeStart: HorizontalTrianglePoint,
  edgeEnd: HorizontalTrianglePoint,
  clipAreaSign: number,
): boolean => {
  const cross = (edgeEnd.x - edgeStart.x) * (point.z - edgeStart.z)
    - (edgeEnd.z - edgeStart.z) * (point.x - edgeStart.x)
  return clipAreaSign >= 0 ? cross >= -0.000001 : cross <= 0.000001
}

const lineIntersection = (
  from: HorizontalTrianglePoint,
  to: HorizontalTrianglePoint,
  clipStart: HorizontalTrianglePoint,
  clipEnd: HorizontalTrianglePoint,
): HorizontalTrianglePoint => {
  const x1 = from.x
  const z1 = from.z
  const x2 = to.x
  const z2 = to.z
  const x3 = clipStart.x
  const z3 = clipStart.z
  const x4 = clipEnd.x
  const z4 = clipEnd.z
  const denominator = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4)
  if (Math.abs(denominator) < 0.000001) return to
  const determinantA = x1 * z2 - z1 * x2
  const determinantB = x3 * z4 - z3 * x4
  return {
    x: (determinantA * (x3 - x4) - (x1 - x2) * determinantB) / denominator,
    z: (determinantA * (z3 - z4) - (z1 - z2) * determinantB) / denominator,
  }
}

const clipPolygonByEdge = (
  subject: ReadonlyArray<HorizontalTrianglePoint>,
  clipStart: HorizontalTrianglePoint,
  clipEnd: HorizontalTrianglePoint,
  clipAreaSign: number,
): ReadonlyArray<HorizontalTrianglePoint> => {
  const output: HorizontalTrianglePoint[] = []
  let previous = subject[subject.length - 1]
  if (!previous) return output
  let previousInside = pointInsideClipEdge(previous, clipStart, clipEnd, clipAreaSign)
  for (const current of subject) {
    const currentInside = pointInsideClipEdge(current, clipStart, clipEnd, clipAreaSign)
    if (currentInside) {
      if (!previousInside) output.push(lineIntersection(previous, current, clipStart, clipEnd))
      output.push(current)
    } else if (previousInside) {
      output.push(lineIntersection(previous, current, clipStart, clipEnd))
    }
    previous = current
    previousInside = currentInside
  }
  return output
}

const convexPolygonOverlapAreaM2 = (
  left: ReadonlyArray<HorizontalTrianglePoint>,
  right: ReadonlyArray<HorizontalTrianglePoint>,
): number => {
  let clipped: ReadonlyArray<HorizontalTrianglePoint> = left
  const clipAreaSign = Math.sign(signedPolygonAreaM2(right)) || 1
  for (let index = 0; index < right.length; index += 1) {
    clipped = clipPolygonByEdge(clipped, right[index]!, right[(index + 1) % right.length]!, clipAreaSign)
    if (clipped.length < 3) return 0
  }
  return Math.abs(signedPolygonAreaM2(clipped))
}

const gridKeysFor = (
  sample: HorizontalPlaneSample,
): ReadonlyArray<string> => {
  const minX = Math.floor(sample.minX / horizontalOverlapGridM)
  const maxX = Math.floor(sample.maxX / horizontalOverlapGridM)
  const minZ = Math.floor(sample.minZ / horizontalOverlapGridM)
  const maxZ = Math.floor(sample.maxZ / horizontalOverlapGridM)
  const keys: string[] = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) keys.push(`${x}:${z}`)
  }
  return keys
}

const horizontalOverlapAuditFor = (
  samples: ReadonlyArray<HorizontalPlaneSample>,
): {
  readonly closeHorizontalOverlapCount: number
  readonly sameMaterialHorizontalOverlapCount: number
  readonly minHorizontalGapM: number | null
  readonly materialPairs: ReadonlyArray<HorizontalOverlapMaterialPairSummary>
} => {
  const cells = new Map<string, HorizontalPlaneSample[]>()
  const seenPairs = new Set<string>()
  let closeHorizontalOverlapCount = 0
  let sameMaterialHorizontalOverlapCount = 0
  let minHorizontalGapM = Number.POSITIVE_INFINITY
  const materialPairs = new Map<string, { count: number; minGapM: number }>()
  const materialPairKeyFor = (left: string, right: string): string =>
    left <= right ? `${left}|${right}` : `${right}|${left}`
  const noteMaterialPair = (
    left: HorizontalPlaneSample,
    right: HorizontalPlaneSample,
    gapM: number,
  ): void => {
    const key = materialPairKeyFor(left.materialKey, right.materialKey)
    const existing = materialPairs.get(key)
    materialPairs.set(key, {
      count: (existing?.count ?? 0) + 1,
      minGapM: Math.min(existing?.minGapM ?? Number.POSITIVE_INFINITY, gapM),
    })
  }
  for (const sample of samples) {
    for (const key of gridKeysFor(sample)) {
      const existingSamples = cells.get(key) ?? []
      for (const existing of existingSamples) {
        const gapM = Math.abs(existing.y - sample.y)
        const overlapAreaM2 = horizontalOverlapAreaM2(existing, sample)
        if (overlapAreaM2 < horizontalOverlapAreaWarningM2) continue
        minHorizontalGapM = Math.min(minHorizontalGapM, gapM)
        if (gapM >= horizontalOverlapGapWarningM) continue
        const pairKey = existing.id < sample.id ? `${existing.id}:${sample.id}` : `${sample.id}:${existing.id}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)
        if (existing.materialKey === sample.materialKey) sameMaterialHorizontalOverlapCount += 1
        closeHorizontalOverlapCount += 1
        noteMaterialPair(existing, sample, gapM)
      }
      existingSamples.push(sample)
      cells.set(key, existingSamples)
    }
  }
  return {
    closeHorizontalOverlapCount,
    sameMaterialHorizontalOverlapCount,
    minHorizontalGapM: Number.isFinite(minHorizontalGapM) ? minHorizontalGapM : null,
    materialPairs: [...materialPairs.entries()]
      .map(([materialKey, value]) => ({ materialKey, count: value.count, minGapM: value.minGapM }))
      .sort((left, right) => right.count - left.count || left.materialKey.localeCompare(right.materialKey)),
  }
}

const riskFinding = (
  config: SceneryTileQualityFinding,
): SceneryTileQualityFinding => config

const auditSceneryTileQuality = (
  tile: SceneryTile,
  primitives: ReadonlyArray<PrimitiveSpec>,
): SceneryTileQualityAudit => {
  const horizontal = horizontalSamplesFor(primitives)
  const overlap = horizontalOverlapAuditFor(horizontal.samples)
  const duplicateSourceRefCount = duplicateSourceRefCountFor(tile)
  const outOfBoundsPointCount = outOfBoundsPointCountFor(tile)
  const findings: SceneryTileQualityFinding[] = []
  if (outOfBoundsPointCount > 0) {
    findings.push(riskFinding({
      severity: 'error',
      code: 'scenery.geometry.out_of_bounds',
      message: 'Source geometry still extends outside the tile after clipping.',
      count: outOfBoundsPointCount,
    }))
  }
  if (overlap.closeHorizontalOverlapCount > 0) {
    findings.push(riskFinding({
      severity: 'warning',
      code: 'scenery.depth.close_horizontal_overlap',
      message: 'Horizontal material planes overlap with too little vertical separation.',
      count: overlap.closeHorizontalOverlapCount,
      ...(overlap.minHorizontalGapM === null ? {} : { minGapM: overlap.minHorizontalGapM }),
    }))
  }
  if (overlap.sameMaterialHorizontalOverlapCount > 0) {
    findings.push(riskFinding({
      severity: 'info',
      code: 'scenery.depth.same_material_horizontal_overlap',
      message: 'Same-material horizontal planes overlap; this can still shimmer under depth precision pressure.',
      count: overlap.sameMaterialHorizontalOverlapCount,
      ...(overlap.minHorizontalGapM === null ? {} : { minGapM: overlap.minHorizontalGapM }),
    }))
  }
  for (const pair of overlap.materialPairs.slice(0, 5)) {
    findings.push(riskFinding({
      severity: 'info',
      code: 'scenery.depth.close_horizontal_overlap_material_pair',
      message: 'Dominant close horizontal overlap material pair.',
      materialKey: pair.materialKey,
      count: pair.count,
      minGapM: pair.minGapM,
    }))
  }
  if (horizontal.duplicateHorizontalTriangleCount > 0) {
    findings.push(riskFinding({
      severity: 'warning',
      code: 'scenery.depth.duplicate_horizontal_triangles',
      message: 'Identical horizontal triangles were emitted more than once in the same tile.',
      count: horizontal.duplicateHorizontalTriangleCount,
    }))
  }
  if (horizontal.degenerateTriangleCount > 0) {
    findings.push(riskFinding({
      severity: horizontal.degenerateTriangleCount > 80 ? 'warning' : 'info',
      code: 'scenery.mesh.degenerate_triangles',
      message: 'The generated GLB contains tiny triangles that can shimmer under minification.',
      count: horizontal.degenerateTriangleCount,
    }))
  }
  if (duplicateSourceRefCount > 0) {
    findings.push(riskFinding({
      severity: duplicateSourceRefCount > 60 ? 'warning' : 'info',
      code: 'scenery.source.duplicate_refs',
      message: 'Multiple compiled features share the same source reference in this tile.',
      count: duplicateSourceRefCount,
    }))
  }
  const warningCount = findings.filter(finding => finding.severity === 'warning').length
  const errorCount = findings.filter(finding => finding.severity === 'error').length
  const riskScore =
    outOfBoundsPointCount * 12
    + overlap.closeHorizontalOverlapCount * 10
    + horizontal.duplicateHorizontalTriangleCount * 16
    + Math.min(120, horizontal.degenerateTriangleCount)
    + Math.min(80, duplicateSourceRefCount)
  return {
    riskScore,
    findingCount: findings.length,
    warningCount,
    errorCount,
    vertexCount: horizontal.vertexCount,
    triangleCount: horizontal.triangleCount,
    horizontalPlaneCount: horizontal.samples.length,
    closeHorizontalOverlapCount: overlap.closeHorizontalOverlapCount,
    sameMaterialHorizontalOverlapCount: overlap.sameMaterialHorizontalOverlapCount,
    duplicateHorizontalTriangleCount: horizontal.duplicateHorizontalTriangleCount,
    duplicateSourceRefCount,
    outOfBoundsPointCount,
    degenerateTriangleCount: horizontal.degenerateTriangleCount,
    minHorizontalGapM: overlap.minHorizontalGapM,
    findings,
  }
}

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const glbFromPrimitives = (
  primitives: ReadonlyArray<PrimitiveSpec>,
): Uint8Array => {
  const chunks: Uint8Array[] = []
  const bufferViews: unknown[] = []
  const accessors: unknown[] = []
  const meshPrimitives: unknown[] = []
  const materialIndexByKey = new Map(materials.map((material, index) => [material.key, index]))

  for (const primitive of primitives) {
    const positionOffset = appendBytes(chunks, bytesForFloat32(primitive.positions))
    const normalOffset = appendBytes(chunks, bytesForFloat32(primitive.normals))
    const indexOffset = appendBytes(chunks, bytesForUint32(primitive.indices))

    const positionViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: primitive.positions.byteLength, target: 34962 })
    const normalViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: primitive.normals.byteLength, target: 34962 })
    const indexViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: primitive.indices.byteLength, target: 34963 })

    const positionAccessorIndex = accessors.length
    const positionBounds = minMaxForPositions(primitive.positions)
    accessors.push({
      bufferView: positionViewIndex,
      byteOffset: 0,
      componentType: 5126,
      count: primitive.positions.length / 3,
      type: 'VEC3',
      min: positionBounds.min,
      max: positionBounds.max,
    })
    const normalAccessorIndex = accessors.length
    accessors.push({
      bufferView: normalViewIndex,
      byteOffset: 0,
      componentType: 5126,
      count: primitive.normals.length / 3,
      type: 'VEC3',
    })
    const indexAccessorIndex = accessors.length
    accessors.push({
      bufferView: indexViewIndex,
      byteOffset: 0,
      componentType: 5125,
      count: primitive.indices.length,
      type: 'SCALAR',
    })

    meshPrimitives.push({
      attributes: {
        POSITION: positionAccessorIndex,
        NORMAL: normalAccessorIndex,
      },
      indices: indexAccessorIndex,
      material: materialIndexByKey.get(primitive.materialKey) ?? 0,
      extras: {
        name: primitive.name,
        droneSceneryKind: primitive.materialKey,
      },
    })
  }

  const bin = concatChunks(chunks)
  const json = {
    asset: {
      version: '2.0',
      generator: 'Leitbild scenery GLB compiler',
      copyright: '© OpenStreetMap contributors; derived scenery generated by Leitbild',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Leitbild scenery tile' }],
    meshes: [{ name: 'Leitbild scenery tile mesh', primitives: meshPrimitives }],
    materials: materials.map(material => ({
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: material.color,
        metallicFactor: material.metallicFactor ?? 0,
        roughnessFactor: material.roughnessFactor ?? 0.8,
      },
      extras: {
        droneSceneryMaterialKey: material.key,
        droneSceneryDepthPolicy: material.depthPolicy,
      },
      ...(material.doubleSided ? { doubleSided: true } : {}),
      ...(material.emissiveFactor ? { emissiveFactor: material.emissiveFactor } : {}),
    })),
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    accessors,
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunkLength = align4(jsonBytes.byteLength)
  const binChunkLength = align4(bin.byteLength)
  const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, jsonChunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  output.fill(0x20, 20, 20 + jsonChunkLength)
  output.set(jsonBytes, 20)
  const binHeaderOffset = 20 + jsonChunkLength
  view.setUint32(binHeaderOffset, binChunkLength, true)
  view.setUint32(binHeaderOffset + 4, 0x004e4942, true)
  output.set(bin, binHeaderOffset + 8)
  return output
}

const featureCountsFor = (tile: SceneryTile): SceneryAssetTileSummary['featureCounts'] => ({
  polygons: tile.features.polygons.length,
  lines: tile.features.lines.length,
  labels: tile.features.labels.length,
  buildings: tile.features.polygons.filter(feature => feature.kind === 'building').length,
  roads: tile.features.lines.filter(feature => feature.kind === 'road').length,
  water: tile.features.polygons.filter(feature => feature.kind === 'water').length + tile.features.lines.filter(feature => feature.kind === 'waterway').length,
  vegetation: tile.features.polygons.filter(feature => feature.kind === 'landcover' || feature.kind === 'landuse').length,
})

export const compileSceneryGlbTile = (
  tile: SceneryTile,
): SceneryGlbBuildResult | null => {
  const center = sceneryTileCenterLonLat(tile.tile)
  const bounds = sceneryTileBounds(tile.tile)
  const lod = lodForTile(tile.tile, bounds, center)
  const profile = lodProfileForZoom(tile.tile.z)
  const budget = detailBudgetForProfile(profile)
  const buckets = new Map<string, MeshBucket>()
  appendSurfaces(buckets, tile, center)
  appendTransport(buckets, tile, center, profile, budget)
  appendBuildings(buckets, tile, center, profile, budget)
  appendVegetation(buckets, tile, center, profile)
  appendPoiBeacons(buckets, tile, center, profile, budget)
  const primitives = primitivesFromBuckets(buckets)
  if (primitives.length === 0) return null
  const localBounds = primitiveBounds(primitives)
  const tileSize = tileSizeMeters(bounds, center)
  const verticalRadiusM = Math.max(Math.abs(localBounds.min[1]), Math.abs(localBounds.max[1]))
  const quality = auditSceneryTileQuality(tile, primitives)
  const bytes = glbFromPrimitives(primitives)
  return {
    bytes,
    summary: {
      recipeId: tile.recipeId,
      z: tile.tile.z,
      x: tile.tile.x,
      y: tile.tile.y,
      centerLon: center.lon,
      centerLat: center.lat,
      bounds,
      boundingSphere: {
        centerLon: center.lon,
        centerLat: center.lat,
        centerHeightM: (localBounds.min[1] + localBounds.max[1]) / 2,
        radiusM: Math.max(1, Math.hypot(tileSize.diagonalM / 2, verticalRadiusM)),
      },
      lod,
      minHeightM: localBounds.min[1],
      maxHeightM: localBounds.max[1],
      featureCounts: featureCountsFor(tile),
      quality,
    },
  }
}

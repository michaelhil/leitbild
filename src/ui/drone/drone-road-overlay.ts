import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color.pure'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Scene } from '@babylonjs/core/scene'
import {
  sceneryRoadTileSchema,
  type SceneryRoadFeature,
  type SceneryRoadTile,
  type SceneryTileCoord,
} from '../../map/scenery.ts'
import { localPointFromLonLat, type DroneWorldCenter } from './drone-map-world.ts'

interface RoadTileRuntimeEntry {
  readonly key: string
  readonly controller: AbortController
  meshes: Mesh[]
  materials: StandardMaterial[]
  loaded: boolean
}

interface RoadTileBounds {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

interface RoadPoint {
  readonly x: number
  readonly z: number
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

export interface DroneRoadSurfaceMeshData {
  readonly key: string
  readonly materialKey: 'road-asphalt'
  readonly colorHex: string
  readonly y: number
  readonly positions: ReadonlyArray<number>
  readonly normals: ReadonlyArray<number>
  readonly indices: ReadonlyArray<number>
  readonly triangleCount: number
}

export interface DroneRoadOverlayMetrics {
  readonly loadedRoadTiles: number
  readonly pendingRoadTiles: number
  readonly roadMeshTriangles: number
  readonly roadTextureBytes: number
}

export interface DroneRoadOverlayRenderer {
  readonly attachTileForModelUrl: (modelUrl: string) => void
  readonly disposeTileForModelUrl: (modelUrl: string) => void
  readonly metrics: () => DroneRoadOverlayMetrics
  readonly dispose: () => void
}

const roadSurfaceY = 1.56
const roadAsphaltColor = '#3f474b'
const metersPerDegreeLat = 111_320

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const tileXToLon = (x: number, z: number): number =>
  x / 2 ** z * 360 - 180

const tileYToLat = (y: number, z: number): number => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z
  return Math.atan(Math.sinh(n)) * 180 / Math.PI
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
): number | null => {
  if (feature.isTunnel) return null
  if (feature.isBridge) return roadSurfaceY + Math.max(2.2, feature.verticalOffsetM)
  return roadSurfaceY + Math.max(0, feature.verticalOffsetM)
}

const roadLayerKey = (
  y: number,
): string => `road:${Math.round(y * 100)}`

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
      z: config.point.z + config.next.nz * config.halfWidthM * config.side,
    }
  }
  const miterX = normalX / normalLength
  const miterZ = normalZ / normalLength
  const denominator = Math.max(0.28, Math.abs(miterX * config.next.nx + miterZ * config.next.nz))
  const length = Math.min(config.halfWidthM * 2.8, config.halfWidthM / denominator)
  return {
    x: config.point.x + miterX * length * config.side,
    z: config.point.z + miterZ * length * config.side,
  }
}

const appendVertex = (
  builder: RoadGeometryBuilder,
  point: RoadPoint,
  y: number,
): number => {
  const index = builder.positions.length / 3
  builder.positions.push(point.x, y, point.z)
  builder.normals.push(0, 1, 0)
  return index
}

const appendRoadRibbon = (
  builder: RoadGeometryBuilder,
  path: ReadonlyArray<RoadPoint>,
  widthM: number,
  y: number,
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
  const halfWidthM = Math.max(1.4, widthM / 2)
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
      ? { x: point.x + next.nx * halfWidthM, z: point.z + next.nz * halfWidthM }
      : !closed && index === roadPoints.length - 1
        ? { x: point.x + previous.nx * halfWidthM, z: point.z + previous.nz * halfWidthM }
        : miterPoint({ point, previous, next, halfWidthM, side: 1 })
    const right = !closed && index === 0
      ? { x: point.x - next.nx * halfWidthM, z: point.z - next.nz * halfWidthM }
      : !closed && index === roadPoints.length - 1
        ? { x: point.x - previous.nx * halfWidthM, z: point.z - previous.nz * halfWidthM }
        : miterPoint({ point, previous, next, halfWidthM, side: -1 })
    leftIndexes.push(appendVertex(builder, left, y))
    rightIndexes.push(appendVertex(builder, right, y))
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

const localRoadPoint = (config: {
  readonly point: readonly [number, number]
  readonly extent: number
  readonly bounds: RoadTileBounds
  readonly center: DroneWorldCenter
}): RoadPoint => {
  const lon = config.bounds.west + config.point[0] / config.extent * (config.bounds.east - config.bounds.west)
  const lat = config.bounds.north + config.point[1] / config.extent * (config.bounds.south - config.bounds.north)
  const local = localPointFromLonLat(lon, lat, config.center)
  return { x: local.x, z: local.z }
}

const orderedRoads = (
  roads: ReadonlyArray<SceneryRoadFeature>,
): ReadonlyArray<SceneryRoadFeature> =>
  [...roads].sort((left, right) =>
    roadSurfaceLayerY(left) === null && roadSurfaceLayerY(right) !== null ? 1
      : roadSurfaceLayerY(left) !== null && roadSurfaceLayerY(right) === null ? -1
        : left.widthM - right.widthM || left.id.localeCompare(right.id),
  )

export const buildRoadSurfaceMeshes = (config: {
  readonly tile: SceneryRoadTile
  readonly center?: DroneWorldCenter
}): ReadonlyArray<DroneRoadSurfaceMeshData> => {
  const bounds = tileBounds(config.tile.tile)
  const center = config.center ?? tileCenter(bounds)
  const builders = new Map<string, { readonly y: number; readonly geometry: RoadGeometryBuilder }>()
  for (const feature of orderedRoads(config.tile.roads)) {
    const y = roadSurfaceLayerY(feature)
    if (y === null) continue
    const key = roadLayerKey(y)
    const entry = builders.get(key) ?? {
      y,
      geometry: {
        positions: [],
        indices: [],
        normals: [],
      },
    }
    if (!builders.has(key)) builders.set(key, entry)
    appendRoadRibbon(
      entry.geometry,
      feature.path.map(point => localRoadPoint({
        point,
        extent: config.tile.tile.extent,
        bounds,
        center,
      })),
      feature.widthM,
      y,
    )
  }
  return [...builders.entries()]
    .filter(([, entry]) => entry.geometry.indices.length > 0)
    .map(([key, entry]) => ({
      key,
      materialKey: 'road-asphalt',
      colorHex: roadAsphaltColor,
      y: entry.y,
      positions: entry.geometry.positions,
      normals: entry.geometry.normals,
      indices: entry.geometry.indices,
      triangleCount: entry.geometry.indices.length / 3,
    }))
}

const createRoadMaterial = (
  scene: Scene,
  surface: DroneRoadSurfaceMeshData,
): StandardMaterial => {
  const material = new StandardMaterial(`drone-${surface.materialKey}`, scene)
  const color = Color3.FromHexString(surface.colorHex)
  material.diffuseColor = color
  material.ambientColor = color.scale(0.28)
  material.specularColor = new Color3(0.04, 0.04, 0.04)
  material.backFaceCulling = false
  material.alpha = 1
  return material
}

const createRoadMesh = (
  scene: Scene,
  surface: DroneRoadSurfaceMeshData,
  material: StandardMaterial,
): Mesh => {
  const mesh = new Mesh(`drone-road-surface:${surface.key}`, scene)
  const vertexData = new VertexData()
  vertexData.positions = [...surface.positions]
  vertexData.normals = [...surface.normals]
  vertexData.indices = [...surface.indices]
  vertexData.applyToMesh(mesh)
  mesh.material = material
  mesh.isPickable = false
  mesh.freezeWorldMatrix()
  return mesh
}

const fetchRoadTile = async (
  url: string,
  signal: AbortSignal,
): Promise<SceneryRoadTile> => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`road overlay tile query failed with HTTP ${response.status}`)
  const parsed = sceneryRoadTileSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`road overlay tile failed schema validation: ${parsed.error.message}`)
  return parsed.data
}

export const createDroneRoadOverlayRenderer = (config: {
  readonly scene: Scene
  readonly center: DroneWorldCenter
  readonly roadTileTemplate: string
  readonly onError?: (message: string) => void
}): DroneRoadOverlayRenderer => {
  const entries = new Map<string, RoadTileRuntimeEntry>()

  const disposeEntry = (entry: RoadTileRuntimeEntry): void => {
    entry.controller.abort()
    for (const mesh of entry.meshes) mesh.dispose(false, true)
    for (const material of entry.materials) material.dispose(false, true)
    entries.delete(entry.key)
  }

  const loadEntry = async (
    entry: RoadTileRuntimeEntry,
    roadTileUrl: string,
  ): Promise<void> => {
    try {
      const tile = await fetchRoadTile(roadTileUrl, entry.controller.signal)
      if (entry.controller.signal.aborted || !entries.has(entry.key)) return
      const surfaces = buildRoadSurfaceMeshes({ tile, center: config.center })
      if (surfaces.length === 0) {
        entries.delete(entry.key)
        return
      }
      for (const surface of surfaces) {
        const material = createRoadMaterial(config.scene, surface)
        const mesh = createRoadMesh(config.scene, surface, material)
        entry.materials.push(material)
        entry.meshes.push(mesh)
      }
      entry.loaded = true
    } catch (error) {
      if (entry.controller.signal.aborted) return
      config.onError?.(error instanceof Error ? error.message : String(error))
      disposeEntry(entry)
    }
  }

  return {
    attachTileForModelUrl: (modelUrl: string): void => {
      const roadTileUrl = roadTileUrlFromModelUrl(modelUrl, config.roadTileTemplate)
      if (!roadTileUrl || entries.has(roadTileUrl)) return
      const entry: RoadTileRuntimeEntry = {
        key: roadTileUrl,
        controller: new AbortController(),
        meshes: [],
        materials: [],
        loaded: false,
      }
      entries.set(roadTileUrl, entry)
      void loadEntry(entry, roadTileUrl)
    },
    disposeTileForModelUrl: (modelUrl: string): void => {
      const roadTileUrl = roadTileUrlFromModelUrl(modelUrl, config.roadTileTemplate)
      if (!roadTileUrl) return
      const entry = entries.get(roadTileUrl)
      if (entry) disposeEntry(entry)
    },
    metrics: (): DroneRoadOverlayMetrics => ({
      loadedRoadTiles: [...entries.values()].filter(entry => entry.loaded).length,
      pendingRoadTiles: [...entries.values()].filter(entry => !entry.loaded).length,
      roadMeshTriangles: [...entries.values()].reduce((sum, entry) => sum + entry.meshes.reduce((meshSum, mesh) => meshSum + mesh.getTotalIndices() / 3, 0), 0),
      roadTextureBytes: 0,
    }),
    dispose: (): void => {
      for (const entry of [...entries.values()]) disposeEntry(entry)
    },
  }
}

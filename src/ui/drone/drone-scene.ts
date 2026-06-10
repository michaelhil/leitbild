import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.pure'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.pure'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { Scene } from '@babylonjs/core/scene'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/loaders/glTF'
import type { OperationalObject } from '../../core/model/index.ts'
import { dronePackDataSchema, type DronePackData } from '../../packs/drone/model.ts'
import { babylonYawRadForHeadingDeg, babylonYawRateRadPerSecForHeadingRateDeg } from '../../packs/drone/spatial.ts'
import { loadDroneMapWorldForScene } from './drone-map-world-loader.ts'
import { coverageForSceneryTiles, type DroneMapWorldSnapshot, type DroneSceneryTileAsset } from './drone-map-world.ts'
import { createDroneFramePerformanceTracker, type DroneScenePerformanceSnapshot } from './drone-performance.ts'
import { terrainHeightAt, type DroneTerrainModel } from './drone-terrain.ts'

export type DroneSceneViewMode = '3d' | '2d' | 'fpv'
export type { DroneScenePerformanceSnapshot }

export interface DroneSceneHandle {
  readonly destroy: () => void
}

export interface DroneSceneCameraOrbit {
  readonly yawOffsetRad: number
  readonly pitchOffsetRad: number
  readonly distanceM: number
}

interface DroneSceneConfig {
  readonly container: HTMLElement
  readonly getFocusDroneId: () => string
  readonly getObjects: () => ReadonlyArray<OperationalObject>
  readonly getViewMode: () => DroneSceneViewMode
  readonly getCameraOrbit: () => DroneSceneCameraOrbit
  readonly onReady?: () => void
  readonly onError?: (message: string) => void
  readonly onWorldStatus?: (message: string) => void
  readonly onPerformance?: (snapshot: DroneScenePerformanceSnapshot) => void
}

interface LocalPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface ObjectPose {
  readonly key: string
  readonly local: LocalPoint
  readonly yawRad: number
  readonly pitchRad: number
  readonly rollRad: number
  readonly scale: number
  readonly velocityEastMps: number
  readonly velocityNorthMps: number
  readonly verticalSpeedMps: number
  readonly yawRateRadPerSec: number
  readonly receivedAtMs: number
  readonly data: DronePackData | null
}

interface VisualPose {
  target: ObjectPose
  readonly position: Vector3
  readonly rotation: Vector3
  scale: number
}

interface CameraPose {
  readonly position: Vector3
  readonly target: Vector3
  readonly fov: number
  readonly minZ: number
  readonly maxZ: number
  readonly mode: DroneSceneViewMode
}

interface CameraRigState {
  readonly position: Vector3
  readonly target: Vector3
  fov: number
  mode: DroneSceneViewMode | null
  initialized: boolean
}

interface MeshEntry {
  readonly signature: string
  readonly root: TransformNode
  readonly visual: VisualPose
}

const metersPerDegreeLat = 111_320
const worldCenterBucketM = 900
const worldStreamPreloadDistanceM = 430
const nearWorldRadiusM = 1_650
const fullWorldRadiusM = 4_250
const droneWorldZoom = 14
const droneWorldLodZooms = [12, 13, 14] as const
const maxDroneScenePixelRatio = 1.6
const maxCachedTileContainers = 256
const tileLoadConcurrency = 2
const cloneImportedSceneryMaterials = true
const scenerySelectionReferenceHeightPx = 960
const scenerySelectionReferenceFovRad = 0.72
const minCameraDistanceM = 14
const maxCameraDistanceM = 260
const minCameraPitchRad = -0.06
const maxCameraPitchRad = 1.18
const sceneryStageRank: Readonly<Record<DroneWorldLoadStage | 'base', number>> = {
  base: 0,
  near: 1,
  full: 2,
}
let activeDroneSceneCount = 0

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const pointFor = (object: OperationalObject) =>
  object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)

const centerFor = (objects: ReadonlyArray<OperationalObject>, focusDroneId: string): { readonly lon: number; readonly lat: number } => {
  const focus = objects.find(object => object.id === focusDroneId)
  const focusPoint = focus ? pointFor(focus) : null
  if (focusPoint) return { lon: focusPoint.coordinates[0], lat: focusPoint.coordinates[1] }
  const points = objects.flatMap(object => {
    const point = pointFor(object)
    return point ? [point] : []
  })
  if (points.length === 0) return { lon: 0, lat: 0 }
  return {
    lon: points.reduce((sum, point) => sum + point.coordinates[0], 0) / points.length,
    lat: points.reduce((sum, point) => sum + point.coordinates[1], 0) / points.length,
  }
}

const localPointFor = (
  object: OperationalObject,
  center: { readonly lon: number; readonly lat: number },
): LocalPoint | null => {
  const point = pointFor(object)
  if (!point) return null
  const droneData = dronePackDataSchema.safeParse(object.packData)
  return {
    x: (point.coordinates[0] - center.lon) * metersPerDegreeLonAt(center.lat),
    y: droneData.success ? droneData.data.pose.altitudeM : 1.4,
    z: -(point.coordinates[1] - center.lat) * metersPerDegreeLat,
  }
}

const material = (scene: Scene, name: string, color: string, alpha = 1): StandardMaterial => {
  const value = new StandardMaterial(name, scene)
  value.diffuseColor = Color3.FromHexString(color)
  value.ambientColor = Color3.FromHexString(color).scale(0.2)
  value.emissiveColor = Color3.FromHexString(color).scale(0.015)
  value.specularColor = new Color3(0.12, 0.12, 0.12)
  value.alpha = alpha
  return value
}

const configureSceneColorPipeline = (scene: Scene): void => {
  scene.clearColor = Color4.FromHexString('#abc7dcff')
  scene.ambientColor = Color3.FromHexString('#b8c8d6')
  scene.environmentIntensity = 0.9
  scene.imageProcessingConfiguration.toneMappingEnabled = true
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
  scene.imageProcessingConfiguration.exposure = 0.92
  scene.imageProcessingConfiguration.contrast = 1.16
  scene.fogMode = Scene.FOGMODE_LINEAR
  scene.fogColor = Color3.FromHexString('#b5c9d9')
  scene.fogStart = 2_800
  scene.fogEnd = 7_400
}

const tuneImportedSceneryMaterial = (mesh: AbstractMesh): void => {
  const imported = mesh.material
  if (imported instanceof PBRMaterial) {
    imported.metallic = 0
    imported.roughness = Math.max(imported.roughness ?? 0.8, 0.78)
    imported.environmentIntensity = Math.min(imported.environmentIntensity ?? 0.72, 0.82)
    return
  }
  if (imported instanceof StandardMaterial) {
    imported.ambientColor = imported.diffuseColor.scale(0.18)
    imported.specularColor = new Color3(0.1, 0.1, 0.1)
    imported.emissiveColor = imported.diffuseColor.scale(0.01)
  }
}

const freezeStaticMesh = (mesh: AbstractMesh): void => {
  mesh.isPickable = false
  mesh.freezeWorldMatrix()
}

const createDroneMesh = (scene: Scene, color: string): TransformNode => {
  const root = new TransformNode('drone', scene)
  const bodyMaterial = material(scene, `drone-body-${color}`, color)
  const darkMaterial = material(scene, 'drone-dark', '#111827')
  const rotorMaterial = material(scene, 'drone-rotor', '#0f172a', 0.72)
  const body = MeshBuilder.CreateBox('body', { width: 2.2, height: 0.38, depth: 1.15 }, scene)
  body.material = bodyMaterial
  body.parent = root
  const nose = MeshBuilder.CreateCylinder('nose', { diameterTop: 0, diameterBottom: 0.84, height: 1.1, tessellation: 18 }, scene)
  nose.material = material(scene, 'drone-nose', '#e2e8f0')
  nose.rotation.x = Math.PI / 2
  nose.position.z = 0.95
  nose.parent = root
  for (const [x, z] of [[-1.4, -1.1], [1.4, -1.1], [-1.4, 1.1], [1.4, 1.1]] as const) {
    const arm = MeshBuilder.CreateBox('arm', { width: 0.18, height: 0.12, depth: 2.6 }, scene)
    arm.material = darkMaterial
    arm.rotation.y = x * z > 0 ? Math.PI / 4 : -Math.PI / 4
    arm.parent = root
    const motor = MeshBuilder.CreateCylinder('motor', { diameter: 0.44, height: 0.16, tessellation: 18 }, scene)
    motor.material = darkMaterial
    motor.position.set(x, 0, z)
    motor.parent = root
    const rotor = MeshBuilder.CreateCylinder('rotor', { diameter: 1.36, height: 0.025, tessellation: 40 }, scene)
    rotor.material = rotorMaterial
    rotor.position.set(x, 0.12, z)
    rotor.parent = root
  }
  return root
}

const createAmbulanceMesh = (scene: Scene): TransformNode => {
  const root = new TransformNode('ambulance', scene)
  const white = material(scene, 'ambulance-white', '#f8fafc')
  const red = material(scene, 'ambulance-red', '#dc2626')
  const dark = material(scene, 'ambulance-dark', '#111827')
  const body = MeshBuilder.CreateBox('ambulance-body', { width: 4.6, height: 1.7, depth: 2.2 }, scene)
  body.material = white
  body.position.y = 0.85
  body.parent = root
  const cab = MeshBuilder.CreateBox('ambulance-cab', { width: 1.7, height: 1.45, depth: 2.05 }, scene)
  cab.material = material(scene, 'ambulance-cab-glass', '#dbeafe')
  cab.position.set(1.65, 1.05, 0)
  cab.parent = root
  const stripe = MeshBuilder.CreateBox('ambulance-stripe', { width: 4.7, height: 0.24, depth: 2.24 }, scene)
  stripe.material = red
  stripe.position.y = 1.2
  stripe.parent = root
  for (const x of [-1.55, 1.45]) {
    for (const z of [-1.16, 1.16]) {
      const wheel = MeshBuilder.CreateCylinder('ambulance-wheel', { diameter: 0.68, height: 0.24, tessellation: 18 }, scene)
      wheel.material = dark
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(x, 0.35, z)
      wheel.parent = root
    }
  }
  return root
}

const createGenericAssetMesh = (scene: Scene, color: string): TransformNode => {
  const root = new TransformNode('asset', scene)
  const base = MeshBuilder.CreateCylinder('asset-base', { diameter: 2.2, height: 0.5, tessellation: 24 }, scene)
  base.material = material(scene, `asset-${color}`, color)
  base.position.y = 0.25
  base.parent = root
  const marker = MeshBuilder.CreateCylinder('asset-marker', { diameterTop: 0, diameterBottom: 1.1, height: 1.6, tessellation: 18 }, scene)
  marker.material = material(scene, 'asset-marker-yellow', '#fbbf24')
  marker.position.y = 1.3
  marker.parent = root
  return root
}

const meshSignatureFor = (object: OperationalObject): string => {
  const droneData = dronePackDataSchema.safeParse(object.packData)
  if (droneData.success) return `drone:${droneData.data.vehicle.visual.color}:${droneData.data.vehicle.visual.scale}`
  if (object.packId === 'ambulance') return 'ambulance'
  return `asset:${object.operational.priority === 'critical' ? 'critical' : 'normal'}`
}

const createMeshFor = (scene: Scene, object: OperationalObject): TransformNode => {
  const droneData = dronePackDataSchema.safeParse(object.packData)
  if (droneData.success) return createDroneMesh(scene, droneData.data.vehicle.visual.color)
  if (object.packId === 'ambulance') return createAmbulanceMesh(scene)
  return createGenericAssetMesh(scene, object.operational.priority === 'critical' ? '#dc2626' : '#f59e0b')
}

const centerDistanceM = (
  a: { readonly lon: number; readonly lat: number },
  b: { readonly lon: number; readonly lat: number },
): number =>
  Math.hypot(
    (a.lon - b.lon) * metersPerDegreeLonAt((a.lat + b.lat) / 2),
    (a.lat - b.lat) * metersPerDegreeLat,
  )

const bucketWorldCenter = (
  center: { readonly lon: number; readonly lat: number },
): { readonly lon: number; readonly lat: number } => {
  const lonMeters = center.lon * metersPerDegreeLonAt(center.lat)
  const latMeters = center.lat * metersPerDegreeLat
  return {
    lon: Math.round(lonMeters / worldCenterBucketM) * worldCenterBucketM / metersPerDegreeLonAt(center.lat),
    lat: Math.round(latMeters / worldCenterBucketM) * worldCenterBucketM / metersPerDegreeLat,
  }
}

const worldCenterKeyFor = (
  center: { readonly lon: number; readonly lat: number },
): string =>
  `${center.lon.toFixed(6)}:${center.lat.toFixed(6)}`

export interface DroneWorldStreamDecision {
  readonly center: { readonly lon: number; readonly lat: number }
  readonly key: string
  readonly reason: 'initial' | 'grid-crossing'
}

export type DroneWorldLoadStage = 'near' | 'full'

export interface DroneWorldLoadSpec {
  readonly stage: DroneWorldLoadStage
  readonly radiusM: number
  readonly zoom: number
  readonly zooms: ReadonlyArray<number>
}

interface BuiltWorldNode {
  readonly root: TransformNode
  readonly stage: DroneWorldLoadStage
  readonly requestedTileCount: number
  readonly selectedTileCount: number
  readonly loadedTileCount: number
  readonly skippedTileCount: number
  readonly coverage: DroneMapWorldSnapshot['coverage']
}

interface LoadedSceneryTile {
  readonly root: TransformNode
  readonly tile: DroneSceneryTileAsset
}

interface SceneryBuildLimits {
  readonly maxTiles: number
  readonly maxBytes: number
  readonly maxTileBytes: number
  readonly targetScreenSpaceError: number
  readonly viewportHeightPx: number
  readonly fovRad: number
}

interface SceneryBuildTiming {
  readonly tileLoadTimeoutMs: number
  readonly stageBuildBudgetMs: number
}

interface SceneTileContainerCache {
  readonly load: (tile: DroneSceneryTileAsset) => Promise<AssetContainer>
  readonly dispose: () => void
}

export const droneWorldLoadSpecsFor = (
  _reason: DroneWorldStreamDecision['reason'],
): ReadonlyArray<DroneWorldLoadSpec> => [
  { stage: 'near', radiusM: nearWorldRadiusM, zoom: droneWorldZoom, zooms: [droneWorldZoom] },
  { stage: 'full', radiusM: fullWorldRadiusM, zoom: droneWorldZoom, zooms: droneWorldLodZooms },
]

export const nextDroneWorldStreamDecision = (config: {
  readonly currentCenter: { readonly lon: number; readonly lat: number } | null
  readonly currentCenterKey: string
  readonly pendingCenterKey: string
  readonly desiredCenter: { readonly lon: number; readonly lat: number }
}): DroneWorldStreamDecision | null => {
  const nextCenter = bucketWorldCenter(config.desiredCenter)
  const nextKey = worldCenterKeyFor(nextCenter)
  if (nextKey === config.pendingCenterKey) return null
  if (config.currentCenter === null) return { center: nextCenter, key: nextKey, reason: 'initial' }
  if (nextKey === config.currentCenterKey) return null
  if (centerDistanceM(config.currentCenter, config.desiredCenter) < worldStreamPreloadDistanceM) return null
  return { center: nextCenter, key: nextKey, reason: 'grid-crossing' }
}

const poseFor = (
  object: OperationalObject,
  center: { readonly lon: number; readonly lat: number },
  receivedAtMs: number,
): ObjectPose | null => {
  const local = localPointFor(object, center)
  if (!local) return null
  const parsed = dronePackDataSchema.safeParse(object.packData)
  const data = parsed.success ? parsed.data : null
  const yawDeg = data?.attitude.yawDeg ?? data?.pose.headingDeg ?? object.spatial.position?.headingDeg ?? 0
  return {
    key: `${center.lon.toFixed(6)}:${center.lat.toFixed(6)}`,
    local,
    yawRad: babylonYawRadForHeadingDeg(yawDeg),
    pitchRad: -(data?.attitude.pitchDeg ?? 0) * Math.PI / 180,
    rollRad: -(data?.attitude.rollDeg ?? 0) * Math.PI / 180,
    scale: data?.vehicle.visual.scale ?? 1,
    velocityEastMps: data?.velocity.eastMps ?? 0,
    velocityNorthMps: data?.velocity.northMps ?? 0,
    verticalSpeedMps: data?.velocity.verticalSpeedMps ?? 0,
    yawRateRadPerSec: babylonYawRateRadPerSecForHeadingRateDeg(data?.attitude.yawRateDegPerSec ?? 0),
    receivedAtMs,
    data,
  }
}

const predictedPose = (
  pose: ObjectPose,
  nowMs: number,
): {
  readonly position: Vector3
  readonly yawRad: number
  readonly pitchRad: number
  readonly rollRad: number
  readonly scale: number
} => {
  const elapsedSeconds = clamp((nowMs - pose.receivedAtMs) / 1000, 0, 0.32)
  return {
    position: new Vector3(
      pose.local.x + pose.velocityEastMps * elapsedSeconds,
      pose.local.y + pose.verticalSpeedMps * elapsedSeconds,
      pose.local.z - pose.velocityNorthMps * elapsedSeconds,
    ),
    yawRad: pose.yawRad + pose.yawRateRadPerSec * elapsedSeconds,
    pitchRad: pose.pitchRad,
    rollRad: pose.rollRad,
    scale: pose.scale,
  }
}

const shortestAngleDeltaRad = (from: number, to: number): number => {
  const full = Math.PI * 2
  return ((to - from + Math.PI) % full + full) % full - Math.PI
}

const smoothVisualPose = (
  visual: VisualPose,
  desired: ReturnType<typeof predictedPose>,
  dtSeconds: number,
  reset: boolean,
  viewMode: DroneSceneViewMode,
): void => {
  const distance = Vector3.Distance(visual.position, desired.position)
  const shouldSnap = reset || distance > 160
  const alpha = shouldSnap ? 1 : 1 - Math.exp(-dtSeconds * (viewMode === 'fpv' ? 18 : 10))
  visual.position.copyFrom(Vector3.Lerp(visual.position, desired.position, alpha))
  visual.rotation.y += shortestAngleDeltaRad(visual.rotation.y, desired.yawRad) * alpha
  visual.rotation.x += shortestAngleDeltaRad(visual.rotation.x, desired.pitchRad) * alpha
  visual.rotation.z += shortestAngleDeltaRad(visual.rotation.z, desired.rollRad) * alpha
  visual.scale += (desired.scale - visual.scale) * alpha
}

const applyTransform = (entry: MeshEntry): void => {
  entry.root.position.copyFrom(entry.visual.position)
  entry.root.rotationQuaternion = Quaternion.FromEulerAngles(entry.visual.rotation.x, entry.visual.rotation.y, entry.visual.rotation.z)
  entry.root.scaling.setAll(entry.visual.scale)
}

const createTerrainGround = (
  scene: Scene,
  radiusM: number,
  terrain?: DroneTerrainModel,
): Mesh => {
  if (terrain?.kind === 'dem') {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let row = 0; row < terrain.gridSize; row += 1) {
      const z = -terrain.radiusM + row * terrain.sampleSpacingM
      for (let column = 0; column < terrain.gridSize; column += 1) {
        const x = -terrain.radiusM + column * terrain.sampleSpacingM
        positions.push(x, terrainHeightAt(terrain, x, z) - 0.12, z)
        uvs.push(column / Math.max(1, terrain.gridSize - 1), row / Math.max(1, terrain.gridSize - 1))
      }
    }
    for (let row = 0; row < terrain.gridSize - 1; row += 1) {
      for (let column = 0; column < terrain.gridSize - 1; column += 1) {
        const base = row * terrain.gridSize + column
        indices.push(base, base + terrain.gridSize, base + 1, base + 1, base + terrain.gridSize, base + terrain.gridSize + 1)
      }
    }
    const mesh = new Mesh('terrain-ground', scene)
    const data = new VertexData()
    data.positions = positions
    data.indices = indices
    data.uvs = uvs
    VertexData.ComputeNormals(positions, indices, data.normals = [])
    data.applyToMesh(mesh)
    mesh.material = material(scene, 'terrain-ground-material', '#5d7d52')
    return mesh
  }
  const mesh = MeshBuilder.CreateGround('flat-ground', { width: radiusM * 2.8, height: radiusM * 2.8, subdivisions: 1 }, scene)
  mesh.material = material(scene, 'flat-ground-material', '#5d7d52')
  mesh.position.y = -0.12
  return mesh
}

const createBaseWorld = (
  scene: Scene,
  radiusM: number,
  terrain?: DroneTerrainModel,
): TransformNode => {
  const root = new TransformNode('babylon-drone-world', scene)
  const sky = MeshBuilder.CreateSphere('sky-dome', { diameter: radiusM * 7, segments: 32 }, scene)
  const skyMaterial = material(scene, 'sky-dome-material', '#a9cce6')
  skyMaterial.disableLighting = true
  skyMaterial.backFaceCulling = false
  sky.material = skyMaterial
  sky.parent = root
  sky.isPickable = false
  const ground = createTerrainGround(scene, radiusM, terrain)
  ground.parent = root
  const hills = MeshBuilder.CreateTorus('distant-hills', { diameter: radiusM * 3, thickness: 80, tessellation: 96 }, scene)
  hills.material = material(scene, 'distant-hills-material', '#6f8292')
  hills.position.y = -20
  hills.parent = root
  for (const mesh of root.getChildMeshes(false)) freezeStaticMesh(mesh)
  return root
}

const tileContainerCacheKey = (
  tile: DroneSceneryTileAsset,
): string =>
  `${tile.recipeId}:${tile.z}/${tile.x}/${tile.y}:${tile.byteLength}`

const createSceneTileContainerCache = (
  scene: Scene,
): SceneTileContainerCache => {
  const cachedTileContainers = new Map<string, Promise<AssetContainer>>()
  const load = async (tile: DroneSceneryTileAsset): Promise<AssetContainer> => {
    const key = tileContainerCacheKey(tile)
    const cached = cachedTileContainers.get(key)
    if (cached) {
      cachedTileContainers.delete(key)
      cachedTileContainers.set(key, cached)
      return await cached
    }
    const promise = (async (): Promise<AssetContainer> => {
      try {
        return await LoadAssetContainerAsync(tile.url, scene)
      } catch (err) {
        cachedTileContainers.delete(key)
        throw err
      }
    })()
    cachedTileContainers.set(key, promise)
    while (cachedTileContainers.size > maxCachedTileContainers) {
      const oldestKey = cachedTileContainers.keys().next().value
      if (typeof oldestKey !== 'string') break
      cachedTileContainers.delete(oldestKey)
    }
    return await promise
  }
  const dispose = (): void => {
    for (const promise of cachedTileContainers.values()) {
      const disposeWhenReady = async (): Promise<void> => {
        try {
          const container = await promise
          container.dispose()
        } catch (err) {
          console.warn('Failed to dispose Babylon scenery tile container', err)
        }
      }
      void disposeWhenReady()
    }
    cachedTileContainers.clear()
  }
  return { load, dispose }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

const terrainY = (terrain: DroneTerrainModel | undefined, x: number, z: number): number =>
  terrain?.kind === 'dem' ? terrainHeightAt(terrain, x, z) : 0

const drapeImportedSceneryMeshToTerrain = (
  mesh: AbstractMesh,
  tile: DroneSceneryTileAsset,
  terrain?: DroneTerrainModel,
): void => {
  if (terrain?.kind !== 'dem') return
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)
  if (!positions || positions.length < 3) return
  const tileOriginY = terrainY(terrain, tile.localOrigin.x, tile.localOrigin.z)
  const mutable = positions instanceof Float32Array ? positions : Float32Array.from(positions as ArrayLike<number>)
  for (let index = 0; index < mutable.length; index += 3) {
    const x = mutable[index] ?? 0
    const z = mutable[index + 2] ?? 0
    mutable[index + 1] = (mutable[index + 1] ?? 0) + terrainY(terrain, tile.localOrigin.x + x, tile.localOrigin.z + z) - tileOriginY
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, mutable, true, true)
  mesh.refreshBoundingInfo(false, false)
}

export const sceneryBuildLimitsFor = (
  stage: DroneWorldLoadStage,
): SceneryBuildLimits =>
  stage === 'near'
    ? {
        maxTiles: 3,
        maxBytes: 7_500_000,
        maxTileBytes: 3_500_000,
        targetScreenSpaceError: 10,
        viewportHeightPx: scenerySelectionReferenceHeightPx,
        fovRad: scenerySelectionReferenceFovRad,
      }
    : {
        maxTiles: 28,
        maxBytes: 120_000_000,
        maxTileBytes: 28_000_000,
        targetScreenSpaceError: 10,
        viewportHeightPx: scenerySelectionReferenceHeightPx,
        fovRad: scenerySelectionReferenceFovRad,
      }

const sceneryBuildTimingFor = (
  stage: DroneWorldLoadStage,
): SceneryBuildTiming =>
  stage === 'near'
    ? { tileLoadTimeoutMs: 3_500, stageBuildBudgetMs: 4_500 }
    : { tileLoadTimeoutMs: 10_000, stageBuildBudgetMs: 18_000 }

export const screenSpaceErrorForSceneryTile = (
  tile: DroneSceneryTileAsset,
  config: {
    readonly viewportHeightPx?: number
    readonly fovRad?: number
  } = {},
): number => {
  const viewportHeightPx = config.viewportHeightPx ?? scenerySelectionReferenceHeightPx
  const fovRad = config.fovRad ?? scenerySelectionReferenceFovRad
  const distanceM = Math.max(1, tile.distanceM - tile.boundingSphere.radiusM)
  return tile.lod.geometricErrorM * viewportHeightPx / (2 * Math.tan(fovRad / 2) * distanceM)
}

const tileCoverageRange = (
  tile: DroneSceneryTileAsset,
  targetZoom = droneWorldZoom,
): { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number } => {
  const scale = 2 ** Math.max(0, targetZoom - tile.z)
  return {
    minX: tile.x * scale,
    maxX: (tile.x + 1) * scale - 1,
    minY: tile.y * scale,
    maxY: (tile.y + 1) * scale - 1,
  }
}

const tileCoverageOverlaps = (
  left: DroneSceneryTileAsset,
  right: DroneSceneryTileAsset,
): boolean => {
  const a = tileCoverageRange(left)
  const b = tileCoverageRange(right)
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

const tileSelectionScore = (
  tile: DroneSceneryTileAsset,
  limits: SceneryBuildLimits,
): number => {
  const screenSpaceError = screenSpaceErrorForSceneryTile(tile, {
    viewportHeightPx: limits.viewportHeightPx,
    fovRad: limits.fovRad,
  })
  const targetRatio = screenSpaceError / limits.targetScreenSpaceError
  const detailNeed = Math.min(4, Math.max(0.2, targetRatio))
  const lodBoost = tile.z * 18
  const distancePenalty = tile.distanceM / 95
  const payloadPenalty = tile.byteLength / Math.max(1_800_000, limits.maxTileBytes * 0.45)
  return detailNeed * 1_000 + lodBoost - distancePenalty - payloadPenalty
}

export const selectSceneryTilesForBuild = (
  tiles: ReadonlyArray<DroneSceneryTileAsset>,
  limits: SceneryBuildLimits,
): ReadonlyArray<DroneSceneryTileAsset> => {
  const selected: DroneSceneryTileAsset[] = []
  let selectedBytes = 0
  const candidates = [...tiles]
    .filter(tile => tile.byteLength <= limits.maxTileBytes)
    .map(tile => ({ tile, score: tileSelectionScore(tile, limits) }))
    .sort((left, right) =>
      right.score - left.score
      || right.tile.z - left.tile.z
      || left.tile.distanceM - right.tile.distanceM
      || left.tile.id.localeCompare(right.tile.id))

  for (const { tile } of candidates) {
    if (selected.length >= limits.maxTiles) break
    if (selected.some(existing => tileCoverageOverlaps(existing, tile))) continue
    const fitsByteBudget = selected.length === 0 || selectedBytes + tile.byteLength <= limits.maxBytes
    if (!fitsByteBudget) continue
    selected.push(tile)
    selectedBytes += tile.byteLength
  }
  return selected.sort((left, right) => left.distanceM - right.distanceM || right.z - left.z || left.id.localeCompare(right.id))
}

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

const createWorldNode = async (
  scene: Scene,
  stage: DroneWorldLoadStage,
  snapshot: DroneMapWorldSnapshot,
  tileCache: SceneTileContainerCache,
  terrain?: DroneTerrainModel,
): Promise<BuiltWorldNode> => {
  const root = new TransformNode(`babylon-drone-scenery:${stage}`, scene)
  const timing = sceneryBuildTimingFor(stage)
  const tileLoadDeadlineMs = performance.now() + timing.stageBuildBudgetMs
  const selectedTiles = selectSceneryTilesForBuild(snapshot.tiles, sceneryBuildLimitsFor(stage))
  const tileResults = await mapWithConcurrency(selectedTiles, tileLoadConcurrency, async tile => {
    if (performance.now() >= tileLoadDeadlineMs) {
      console.warn(`Skipping Babylon scenery tile ${tile.id}; stage tile budget exhausted`)
      return null
    }
    const tilePromise = tileCache.load(tile)
    try {
      const remainingBudgetMs = Math.max(1, tileLoadDeadlineMs - performance.now())
      const container = await withTimeout(
        tilePromise,
        Math.min(timing.tileLoadTimeoutMs, remainingBudgetMs),
        `Babylon scenery tile ${tile.id} did not load within the interactive stage budget`,
      )
      const entries = container.instantiateModelsToScene(sourceName => `${tile.id}:${sourceName}`, cloneImportedSceneryMaterials)
      const tileRoot = new TransformNode(`tile:${tile.id}`, scene)
      tileRoot.parent = root
      tileRoot.position.set(tile.localOrigin.x, terrainY(terrain, tile.localOrigin.x, tile.localOrigin.z), tile.localOrigin.z)
      for (const node of entries.rootNodes) {
        if (node instanceof TransformNode) node.parent = tileRoot
      }
      for (const mesh of tileRoot.getChildMeshes(false)) {
        drapeImportedSceneryMeshToTerrain(mesh, tile, terrain)
        tuneImportedSceneryMaterial(mesh)
        freezeStaticMesh(mesh)
      }
      tileRoot.freezeWorldMatrix()
      return { root: tileRoot, tile }
    } catch (err) {
      console.warn(`Skipping Babylon scenery tile ${tile.id}`, err)
      return null
    }
  })
  const loadedResults = tileResults.filter((result): result is LoadedSceneryTile => result !== null)
  const skippedTileCount = snapshot.tiles.length - loadedResults.length
  const baseCoverage = coverageForSceneryTiles(loadedResults.map(result => result.tile))
  const coverage = skippedTileCount === 0
    ? baseCoverage
    : {
        ...baseCoverage,
        notes: [
          ...baseCoverage.notes,
          `${skippedTileCount} scenery tiles were deferred by the interactive tile budget.`,
        ],
      }
  for (const tileResult of loadedResults) tileResult.root.parent = root
  root.metadata = {
    key: snapshot.key,
    tileCount: loadedResults.length,
    requestedTileCount: snapshot.tileCount,
    skippedTileCount,
    coverage,
    scenerySource: snapshot.scenerySource,
    terrain: terrain?.kind ?? 'flat',
  }
  return {
    root,
    stage,
    requestedTileCount: snapshot.tileCount,
    selectedTileCount: selectedTiles.length,
    loadedTileCount: loadedResults.length,
    skippedTileCount,
    coverage,
  }
}

const disposeDynamicWorldNode = (
  node: TransformNode | null,
): void => {
  node?.dispose(false, false)
}

export const shouldPromoteSceneryStage = (config: {
  readonly visibleStage: DroneWorldLoadStage | 'base'
  readonly visibleLoadedTileCount: number
  readonly visibleCenterKey: string
  readonly candidateStage: DroneWorldLoadStage
  readonly candidateLoadedTileCount: number
  readonly candidateCenterKey: string
}): boolean => {
  if (config.candidateLoadedTileCount <= 0) return false
  const candidateRank = sceneryStageRank[config.candidateStage]
  const visibleRank = sceneryStageRank[config.visibleStage]
  if (config.visibleStage === 'base') return true
  if (config.candidateCenterKey !== config.visibleCenterKey) {
    const minimumUsefulTileCount = Math.max(4, Math.ceil(config.visibleLoadedTileCount * 0.25))
    return config.candidateStage === 'full' && config.candidateLoadedTileCount >= minimumUsefulTileCount
  }
  if (candidateRank > visibleRank) return true
  if (candidateRank < visibleRank) return false
  return config.candidateLoadedTileCount >= config.visibleLoadedTileCount
}

const cameraTargetFor = (
  meshes: ReadonlyMap<string, MeshEntry>,
  focusDroneId: string,
): Vector3 => meshes.get(focusDroneId)?.visual.position ?? new Vector3(0, 28, -42)

const desiredCameraPoseFor = (
  target: Vector3,
  viewMode: DroneSceneViewMode,
  focus: MeshEntry | undefined,
  orbit: DroneSceneCameraOrbit,
): CameraPose => {
  if (viewMode === '2d') {
    return {
      position: new Vector3(target.x, Math.max(450, target.y + 520), target.z - 0.01),
      target,
      fov: 0.52,
      minZ: 0.5,
      maxZ: 8_000,
      mode: viewMode,
    }
  }
  if (viewMode === 'fpv' && focus) {
    const yaw = focus.visual.rotation.y
    const offset = new Vector3(Math.sin(yaw) * -1.2, 0.45, Math.cos(yaw) * -1.2)
    return {
      position: focus.visual.position.add(offset),
      target: focus.visual.position.add(new Vector3(Math.sin(yaw) * 80, -2, Math.cos(yaw) * 80)),
      fov: 1.1,
      minZ: 0.08,
      maxZ: 6_000,
      mode: viewMode,
    }
  }
  const baseYaw = focus?.visual.rotation.y ?? 0
  const yaw = baseYaw + orbit.yawOffsetRad
  const pitch = clamp(orbit.pitchOffsetRad, minCameraPitchRad, maxCameraPitchRad)
  const distanceM = clamp(orbit.distanceM, minCameraDistanceM, maxCameraDistanceM)
  const horizontalDistanceM = Math.max(4, distanceM * Math.cos(pitch))
  const heightM = 5 + distanceM * Math.sin(pitch)
  const forward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw))
  const cameraPosition = new Vector3(
    target.x - forward.x * horizontalDistanceM,
    target.y + heightM,
    target.z - forward.z * horizontalDistanceM,
  )
  const lookTarget = new Vector3(
    target.x + forward.x * 18,
    target.y + 5.5,
    target.z + forward.z * 18,
  )
  return {
    position: cameraPosition,
    target: lookTarget,
    fov: 0.72,
    minZ: 0.2,
    maxZ: 6_000,
    mode: viewMode,
  }
}

const applyCameraPose = (
  camera: UniversalCamera,
  rig: CameraRigState,
  desired: CameraPose,
  dtSeconds: number,
): void => {
  const modeChanged = rig.mode !== desired.mode
  const distance = Vector3.Distance(rig.position, desired.position)
  const shouldSnap = !rig.initialized || modeChanged || distance > 900 || desired.mode === '2d'
  const alpha = shouldSnap ? 1 : 1 - Math.exp(-dtSeconds * (desired.mode === 'fpv' ? 11 : 7.5))
  rig.position.copyFrom(Vector3.Lerp(rig.position, desired.position, alpha))
  rig.target.copyFrom(Vector3.Lerp(rig.target, desired.target, alpha))
  rig.fov += (desired.fov - rig.fov) * alpha
  rig.mode = desired.mode
  rig.initialized = true
  camera.position.copyFrom(rig.position)
  camera.setTarget(rig.target)
  camera.fov = rig.fov
  camera.minZ = desired.minZ
  camera.maxZ = desired.maxZ
}

export const createDroneScene = (config: DroneSceneConfig): DroneSceneHandle => {
  activeDroneSceneCount += 1
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  config.container.appendChild(canvas)
  const engine = new Engine(canvas, true, {
    adaptToDeviceRatio: false,
    powerPreference: 'high-performance',
  })
  const scene = new Scene(engine)
  configureSceneColorPipeline(scene)
  scene.skipPointerMovePicking = true
  scene.autoClearDepthAndStencil = true
  const camera = new UniversalCamera('drone-camera', new Vector3(0, 90, -120), scene)
  camera.fov = 0.84
  new HemisphericLight('ambient', new Vector3(0, 1, 0), scene).intensity = 0.48
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, -0.35), scene)
  sun.intensity = 1.34
  const tileCache = createSceneTileContainerCache(scene)
  const performanceTracker = createDroneFramePerformanceTracker()
  const objectMeshes = new Map<string, MeshEntry>()
  let baseWorldNode: TransformNode | null = createBaseWorld(scene, nearWorldRadiusM)
  let sceneryLayerNode: TransformNode | null = null
  let worldCenter: { readonly lon: number; readonly lat: number } | null = null
  let worldCenterKey = ''
  let pendingWorldCenterKey = ''
  let worldLoadGeneration = 0
  let visibleWorldStage: DroneWorldLoadStage | 'base' = 'base'
  let visibleWorldLoadedTileCount = 0
  let visibleWorldCoverage: DroneMapWorldSnapshot['coverage'] = coverageForSceneryTiles([])
  let destroyed = false
  let renderQuality: DroneScenePerformanceSnapshot['quality'] = 'balanced'
  let pixelRatio = Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio)
  let lastFrameAt = performance.now()
  let readyNotified = false
  const cameraRig: CameraRigState = {
    position: camera.position.clone(),
    target: Vector3.Zero(),
    fov: camera.fov,
    mode: null,
    initialized: false,
  }

  performanceTracker.updateWorld({
    sceneryStage: 'base',
    scenerySource: 'asset-tiles',
    loadMs: 0,
    buildMs: 0,
    source: 'asset-tiles',
    tiles: 0,
    polygons: 0,
    lines: 0,
    points: 0,
    buildings: 0,
    roads: 0,
    water: 0,
    vegetation: 0,
    roadLabels: 0,
    terrain: 'unknown',
    terrainSurface: 'flat',
  })

  const setPixelRatio = (ratio: number, quality: DroneScenePerformanceSnapshot['quality']): void => {
    const next = clamp(ratio, 0.75, Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio))
    pixelRatio = next
    renderQuality = quality
    engine.setHardwareScalingLevel(1 / next)
    engine.resize()
  }
  setPixelRatio(pixelRatio, renderQuality)

  const notifyReadyOnce = (): void => {
    if (readyNotified) return
    readyNotified = true
    config.onReady?.()
  }

  const promoteWorld = (config: {
    readonly base: TransformNode
    readonly layer: BuiltWorldNode
    readonly center: { readonly lon: number; readonly lat: number }
    readonly centerKey: string
  }): void => {
    const previousBase = baseWorldNode
    const previousLayer = sceneryLayerNode
    baseWorldNode = config.base
    sceneryLayerNode = config.layer.root
    worldCenter = config.center
    worldCenterKey = config.centerKey
    visibleWorldStage = config.layer.stage
    visibleWorldLoadedTileCount = config.layer.loadedTileCount
    visibleWorldCoverage = config.layer.coverage
    disposeDynamicWorldNode(previousLayer)
    disposeDynamicWorldNode(previousBase)
  }

  const shouldPromoteWorld = (
    candidate: BuiltWorldNode,
    centerKey: string,
  ): boolean =>
    shouldPromoteSceneryStage({
      visibleStage: visibleWorldStage,
      visibleLoadedTileCount: visibleWorldLoadedTileCount,
      visibleCenterKey: worldCenterKey,
      candidateStage: candidate.stage,
      candidateLoadedTileCount: candidate.loadedTileCount,
      candidateCenterKey: centerKey,
    })

  const loadWorld = async (decision: DroneWorldStreamDecision): Promise<void> => {
    const generation = ++worldLoadGeneration
    pendingWorldCenterKey = decision.key
    let promotedAny = false
    try {
      for (const spec of droneWorldLoadSpecsFor(decision.reason)) {
        const loadStarted = performance.now()
        config.onWorldStatus?.(`Loading ${spec.stage} Babylon scenery`)
        const result = await loadDroneMapWorldForScene({ center: decision.center, radiusM: spec.radiusM, zoom: spec.zoom, zooms: spec.zooms })
        const loadedAt = performance.now()
        const next = await createWorldNode(scene, spec.stage, result.snapshot, tileCache, result.terrainModel)
        const nextBase = createBaseWorld(scene, result.snapshot.radiusM, result.terrainModel)
        const builtAt = performance.now()
        if (destroyed || generation !== worldLoadGeneration) {
          disposeDynamicWorldNode(next.root)
          disposeDynamicWorldNode(nextBase)
          return
        }
        const promoted = shouldPromoteWorld(next, decision.key)
        if (promoted) {
          promoteWorld({
            base: nextBase,
            layer: next,
            center: decision.center,
            centerKey: decision.key,
          })
          pendingWorldCenterKey = ''
          promotedAny = true
        } else {
          disposeDynamicWorldNode(next.root)
          disposeDynamicWorldNode(nextBase)
        }
        performanceTracker.updateWorld({
          sceneryStage: promoted ? spec.stage : visibleWorldStage,
          scenerySource: result.snapshot.scenerySource,
          loadMs: loadedAt - loadStarted,
          buildMs: builtAt - loadedAt,
          source: result.source,
          tiles: promoted ? next.loadedTileCount : visibleWorldLoadedTileCount,
          polygons: visibleWorldCoverage.selected.polygons,
          lines: visibleWorldCoverage.selected.lines,
          points: visibleWorldCoverage.selected.points,
          buildings: visibleWorldCoverage.selected.buildings,
          roads: visibleWorldCoverage.selected.roads,
          water: visibleWorldCoverage.selected.waterPolygons + visibleWorldCoverage.selected.waterways,
          vegetation: visibleWorldCoverage.selected.vegetationPolygons,
          roadLabels: visibleWorldCoverage.selected.roadLabels,
          terrain: result.terrain.status,
          terrainSurface: result.terrainModel.kind === 'dem' ? 'dem' : 'flat',
        })
        const attemptText = next.selectedTileCount > 0 && next.selectedTileCount < next.requestedTileCount ? ` · ${next.selectedTileCount} attempted` : ''
        const skippedText = next.skippedTileCount > 0 ? ` · ${next.skippedTileCount} deferred` : ''
        const promotionText = promoted ? 'ready' : `kept ${visibleWorldStage} scene`
        config.onWorldStatus?.(`${spec.stage} Babylon scenery ${promotionText} · ${next.loadedTileCount}/${next.requestedTileCount} tiles${attemptText}${skippedText}`)
        notifyReadyOnce()
      }
      if (!promotedAny && generation === worldLoadGeneration) pendingWorldCenterKey = ''
    } catch (err) {
      pendingWorldCenterKey = ''
      config.onError?.(err instanceof Error ? err.message : String(err))
      notifyReadyOnce()
    }
  }

  const updateObjects = (objects: ReadonlyArray<OperationalObject>, center: { readonly lon: number; readonly lat: number }, nowMs: number, dtSeconds: number): void => {
    const seen = new Set<string>()
    for (const object of objects) {
      const pose = poseFor(object, center, nowMs)
      if (!pose) continue
      seen.add(object.id)
      const signature = meshSignatureFor(object)
      const current = objectMeshes.get(object.id)
      const reset = current === undefined || current.signature !== signature || current.visual.target.key !== pose.key
      const entry = current && current.signature === signature
        ? current
        : (() => {
            current?.root.dispose(false, true)
            const root = createMeshFor(scene, object)
            const visual: VisualPose = {
              target: pose,
              position: new Vector3(pose.local.x, pose.local.y, pose.local.z),
              rotation: new Vector3(pose.pitchRad, pose.yawRad, pose.rollRad),
              scale: pose.scale,
            }
            const next = { signature, root, visual }
            objectMeshes.set(object.id, next)
            return next
          })()
      entry.visual.target = pose
      smoothVisualPose(entry.visual, predictedPose(pose, nowMs), dtSeconds, reset, config.getViewMode())
      applyTransform(entry)
    }
    for (const [id, entry] of objectMeshes) {
      if (seen.has(id)) continue
      entry.root.dispose(false, true)
      objectMeshes.delete(id)
    }
  }

  const maybeReportPerformance = (renderStarted: number, nowMs: number): void => {
    const result = performanceTracker.endFrame(nowMs, performance.now() - renderStarted)
    if (!result.shouldReport) return
    const meshes = scene.meshes.length
    const triangles = scene.meshes.reduce((sum, mesh) => sum + (mesh.getTotalIndices() / 3 || 0), 0)
    const snapshot = performanceTracker.snapshot({
      drawCalls: scene.getActiveMeshes().length,
      triangles: Math.round(triangles),
      geometries: meshes,
      textures: scene.textures.length,
      pixelRatio,
      quality: renderQuality,
      activeScenes: activeDroneSceneCount,
    })
    if (snapshot.frameP95Ms > 46 && pixelRatio > 0.82) setPixelRatio(pixelRatio - 0.1, 'rescue')
    else if (snapshot.frameP95Ms <= 22 && pixelRatio < maxDroneScenePixelRatio) setPixelRatio(pixelRatio + 0.04, 'balanced')
    config.onPerformance?.(snapshot)
  }

  const resizeObserver = new ResizeObserver(() => engine.resize())
  resizeObserver.observe(config.container)

  engine.runRenderLoop(() => {
    if (destroyed) return
    const nowMs = performance.now()
    const dtSeconds = clamp((nowMs - lastFrameAt) / 1000, 0, 0.08)
    lastFrameAt = nowMs
    performanceTracker.beginFrame(nowMs)
    const objects = config.getObjects()
    const desiredCenter = centerFor(objects, config.getFocusDroneId())
    const decision = nextDroneWorldStreamDecision({
      currentCenter: worldCenter,
      currentCenterKey: worldCenterKey,
      pendingCenterKey: pendingWorldCenterKey,
      desiredCenter,
    })
    if (decision) {
      pendingWorldCenterKey = decision.key
      void loadWorld(decision)
    }
    const activeCenter = worldCenter ?? desiredCenter
    updateObjects(objects, activeCenter, nowMs, dtSeconds)
    const focusId = config.getFocusDroneId()
    const focus = objectMeshes.get(focusId)
    applyCameraPose(camera, cameraRig, desiredCameraPoseFor(
      cameraTargetFor(objectMeshes, focusId),
      config.getViewMode(),
      focus,
      config.getCameraOrbit(),
    ), dtSeconds)
    const renderStarted = performance.now()
    scene.render()
    notifyReadyOnce()
    maybeReportPerformance(renderStarted, performance.now())
  })

  return {
    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      activeDroneSceneCount = Math.max(0, activeDroneSceneCount - 1)
      resizeObserver.disconnect()
      engine.stopRenderLoop()
      for (const entry of objectMeshes.values()) entry.root.dispose(false, true)
      objectMeshes.clear()
      disposeDynamicWorldNode(sceneryLayerNode)
      disposeDynamicWorldNode(baseWorldNode)
      tileCache.dispose()
      scene.dispose()
      engine.dispose()
      canvas.remove()
    },
  }
}

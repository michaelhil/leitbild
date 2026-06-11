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
import '@babylonjs/loaders/glTF'
import type { OperationalObject } from '../../core/model/index.ts'
import { dronePackDataSchema, type DronePackData } from '../../packs/drone/model.ts'
import type { DroneMotionFrame } from '../../packs/drone/realtime.ts'
import { babylonYawRadForHeadingDeg, babylonYawRateRadPerSecForHeadingRateDeg } from '../../packs/drone/spatial.ts'
import {
  loadDroneWorldTerrainStatus,
  localPointFromLonLat,
  type DroneWorldCenter,
  type DroneWorldTerrainStatus,
} from './drone-map-world.ts'
import {
  createDroneSceneryTilesRenderer,
  loadDroneSceneryTilesetInfo,
  loadDroneWorldSceneryTilesetStatus,
  type DroneSceneryTilesRenderer,
} from './drone-scenery-tiles.ts'
import { createDroneRoadOverlayRenderer, type DroneRoadOverlayRenderer } from './drone-road-overlay.ts'
import { createDroneFramePerformanceTracker, type DroneScenePerformanceSnapshot } from './drone-performance.ts'
import type { DroneSceneCameraOrbit, DroneSceneConfig, DroneSceneHandle, DroneSceneViewMode } from './drone-scene-types.ts'
import {
  loadDroneTerrainModel,
  terrainHeightAt,
  terrainSurfaceGeometryFor,
  type DroneTerrainModel,
} from './drone-terrain.ts'

export type { DroneSceneCameraOrbit, DroneSceneConfig, DroneSceneHandle, DroneSceneViewMode }
export type { DroneScenePerformanceSnapshot }

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

interface MotionFrameRecord {
  readonly frame: DroneMotionFrame
  readonly receivedAtMs: number
}

const maxDroneScenePixelRatio = 1.5
const motionFrameMaxAgeMs = 500
const minCameraDistanceM = 14
const maxCameraDistanceM = 260
const minCameraPitchRad = -0.06
const maxCameraPitchRad = 1.18
const baseGroundRadiusM = 9_000
let activeDroneSceneCount = 0

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const pointFor = (object: OperationalObject) =>
  object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)

const centerFor = (
  objects: ReadonlyArray<OperationalObject>,
  focusDroneId: string,
): DroneWorldCenter => {
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
  center: DroneWorldCenter,
  terrain: DroneTerrainModel,
): LocalPoint | null => {
  const point = pointFor(object)
  if (!point) return null
  const droneData = dronePackDataSchema.safeParse(object.packData)
  const local = localPointFromLonLat(point.coordinates[0], point.coordinates[1], center)
  const groundY = terrainHeightAt(terrain, local.x, local.z)
  return {
    x: local.x,
    y: groundY + (droneData.success ? droneData.data.pose.altitudeM : 1.4),
    z: local.z,
  }
}

const localPointForMotionFrame = (
  frame: DroneMotionFrame,
  center: DroneWorldCenter,
  terrain: DroneTerrainModel,
): LocalPoint => {
  const local = localPointFromLonLat(frame.lon, frame.lat, center)
  const groundY = terrainHeightAt(terrain, local.x, local.z)
  return {
    x: local.x,
    y: groundY + frame.altitudeM,
    z: local.z,
  }
}

const material = (scene: Scene, name: string, color: string, alpha = 1): StandardMaterial => {
  const value = new StandardMaterial(name, scene)
  value.diffuseColor = Color3.FromHexString(color)
  value.ambientColor = Color3.FromHexString(color).scale(0.22)
  value.emissiveColor = Color3.FromHexString(color).scale(0.012)
  value.specularColor = new Color3(0.12, 0.12, 0.12)
  value.alpha = alpha
  return value
}

const configureSceneColorPipeline = (scene: Scene): void => {
  scene.clearColor = Color4.FromHexString('#abc7dcff')
  scene.ambientColor = Color3.FromHexString('#c2ccd5')
  scene.environmentIntensity = 0.9
  scene.imageProcessingConfiguration.toneMappingEnabled = true
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
  scene.imageProcessingConfiguration.exposure = 0.94
  scene.imageProcessingConfiguration.contrast = 1.14
  scene.fogMode = Scene.FOGMODE_LINEAR
  scene.fogColor = Color3.FromHexString('#b7cad8')
  scene.fogStart = 3_200
  scene.fogEnd = 9_600
}

const tuneImportedSceneryMaterial = (mesh: AbstractMesh): void => {
  mesh.isPickable = false
  const imported = mesh.material
  if (imported instanceof PBRMaterial) {
    imported.metallic = 0
    imported.roughness = Math.max(imported.roughness ?? 0.8, 0.74)
    imported.environmentIntensity = Math.min(imported.environmentIntensity ?? 0.75, 0.9)
    return
  }
  if (imported instanceof StandardMaterial) {
    imported.ambientColor = imported.diffuseColor.scale(0.24)
    imported.specularColor = new Color3(0.12, 0.12, 0.12)
    imported.emissiveColor = imported.diffuseColor.scale(0.012)
  }
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

const poseFor = (
  object: OperationalObject,
  center: DroneWorldCenter,
  terrain: DroneTerrainModel,
  receivedAtMs: number,
): ObjectPose | null => {
  const local = localPointFor(object, center, terrain)
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

const poseForMotionFrame = (
  record: MotionFrameRecord,
  object: OperationalObject,
  center: DroneWorldCenter,
  terrain: DroneTerrainModel,
): ObjectPose => {
  const frame = record.frame
  const parsed = dronePackDataSchema.safeParse(object.packData)
  const data = parsed.success ? parsed.data : null
  return {
    key: `${center.lon.toFixed(6)}:${center.lat.toFixed(6)}`,
    local: localPointForMotionFrame(frame, center, terrain),
    yawRad: babylonYawRadForHeadingDeg(frame.headingDeg),
    pitchRad: -frame.pitchDeg * Math.PI / 180,
    rollRad: -frame.rollDeg * Math.PI / 180,
    scale: data?.vehicle.visual.scale ?? 1,
    velocityEastMps: frame.eastMps,
    velocityNorthMps: frame.northMps,
    verticalSpeedMps: frame.verticalSpeedMps,
    yawRateRadPerSec: babylonYawRateRadPerSecForHeadingRateDeg(frame.yawRateDegPerSec),
    receivedAtMs: record.receivedAtMs,
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

interface StableBaseWorld {
  readonly root: TransformNode
  readonly referenceGround: AbstractMesh
  readonly distantHaze: AbstractMesh
}

const createStableBaseWorld = (scene: Scene): StableBaseWorld => {
  const root = new TransformNode('babylon-drone-stable-base-world', scene)
  const sky = MeshBuilder.CreateSphere('stable-sky-dome', { diameter: baseGroundRadiusM * 7, segments: 32 }, scene)
  const skyMaterial = material(scene, 'stable-sky-dome-material', '#a9cce6')
  skyMaterial.disableLighting = true
  skyMaterial.backFaceCulling = false
  sky.material = skyMaterial
  sky.isPickable = false
  sky.parent = root

  const ground = MeshBuilder.CreateGround('stable-reference-ground', { width: baseGroundRadiusM * 2.4, height: baseGroundRadiusM * 2.4, subdivisions: 1 }, scene)
  ground.material = material(scene, 'stable-reference-ground-material', '#7c8878')
  ground.position.y = -0.18
  ground.isPickable = false
  ground.parent = root

  const haze = MeshBuilder.CreateTorus('stable-distant-haze-ring', { diameter: baseGroundRadiusM * 2.8, thickness: 70, tessellation: 96 }, scene)
  haze.material = material(scene, 'stable-distant-haze-material', '#6f8292')
  haze.position.y = -24
  haze.isPickable = false
  haze.parent = root

  return {
    root,
    referenceGround: ground,
    distantHaze: haze,
  }
}

const createTerrainSurface = (
  scene: Scene,
  model: DroneTerrainModel,
): TransformNode | null => {
  const geometry = terrainSurfaceGeometryFor(model)
  if (!geometry) return null
  const root = new TransformNode('babylon-drone-dem-terrain-root', scene)
  const mesh = new Mesh('babylon-drone-dem-terrain-surface', scene)
  const normals: number[] = []
  VertexData.ComputeNormals(geometry.positions, geometry.indices, normals)
  const vertexData = new VertexData()
  vertexData.positions = geometry.positions
  vertexData.indices = geometry.indices
  vertexData.normals = normals
  vertexData.applyToMesh(mesh)
  const terrainMaterial = material(scene, 'babylon-drone-dem-terrain-material', '#6f8067')
  terrainMaterial.specularColor = new Color3(0.02, 0.025, 0.02)
  terrainMaterial.ambientColor = Color3.FromHexString('#6f8067').scale(0.28)
  mesh.material = terrainMaterial
  mesh.isPickable = false
  mesh.parent = root
  mesh.freezeWorldMatrix()
  return root
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
      minZ: 1.5,
      maxZ: 6_500,
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
      minZ: 0.45,
      maxZ: 4_500,
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
  return {
    position: new Vector3(
      target.x - forward.x * horizontalDistanceM,
      target.y + heightM,
      target.z - forward.z * horizontalDistanceM,
    ),
    target: new Vector3(
      target.x + forward.x * 18,
      target.y + 5.5,
      target.z + forward.z * 18,
    ),
    fov: 0.72,
    minZ: 0.75,
    maxZ: 5_500,
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

const terrainLabel = (
  terrain: DroneWorldTerrainStatus,
): DroneScenePerformanceSnapshot['worldFeatures']['terrain'] =>
  terrain.status === 'available' ? 'available' : terrain.status === 'unavailable' ? 'unavailable' : 'unknown'

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
    useLargeWorldRendering: true,
  })
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  configureSceneColorPipeline(scene)
  scene.skipPointerMovePicking = true
  scene.autoClearDepthAndStencil = true
  const baseWorld = createStableBaseWorld(scene)

  const camera = new UniversalCamera('drone-camera', new Vector3(0, 90, -120), scene)
  camera.fov = 0.84
  scene.activeCamera = camera
  new HemisphericLight('ambient', new Vector3(0, 1, 0), scene).intensity = 0.52
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, -0.35), scene)
  sun.intensity = 1.42

  const performanceTracker = createDroneFramePerformanceTracker()
  const objectMeshes = new Map<string, MeshEntry>()
  const motionFramesByObjectId = new Map<string, MotionFrameRecord>()
  let destroyed = false
  let sceneOriginCenter: DroneWorldCenter | null = null
  let terrainStatus: DroneWorldTerrainStatus = {
    status: 'unavailable',
    reason: 'terrain DEM is not attached to the Babylon scenery surface',
  }
  let terrainModel: DroneTerrainModel = {
    kind: 'flat',
    reason: terrainStatus.reason,
  }
  let terrainRoot: TransformNode | null = null
  let sceneryRenderer: DroneSceneryTilesRenderer | null = null
  let roadOverlayRenderer: DroneRoadOverlayRenderer | null = null
  let sceneryLoadMs = 0
  let readyNotified = false
  let lastFrameAt = performance.now()
  const pixelRatio = Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio)
  engine.setHardwareScalingLevel(1 / pixelRatio)
  engine.resize()

  const cameraRig: CameraRigState = {
    position: camera.position.clone(),
    target: Vector3.Zero(),
    fov: camera.fov,
    mode: null,
    initialized: false,
  }

  const notifyReadyOnce = (): void => {
    if (readyNotified) return
    readyNotified = true
    config.onReady?.()
  }

  const initializeScenery = async (): Promise<void> => {
    const startedAt = performance.now()
    try {
      config.onWorldStatus?.('Checking 3D scenery capability')
      const sceneryStatus = await loadDroneWorldSceneryTilesetStatus()
      if (destroyed) return
      if (sceneryStatus.status !== 'available') {
        config.onError?.(`scenery capability unavailable: ${sceneryStatus.reason}`)
        notifyReadyOnce()
        return
      }
      config.onWorldStatus?.('Loading 3D scenery manifest')
      const info = await loadDroneSceneryTilesetInfo({ status: sceneryStatus })
      if (destroyed) return
      sceneOriginCenter = { lon: info.origin.lon, lat: info.origin.lat }
      if (info.terrainAligned) {
        try {
          config.onWorldStatus?.('Loading DEM terrain')
          terrainStatus = await loadDroneWorldTerrainStatus()
          if (!destroyed) {
            terrainModel = await loadDroneTerrainModel({
              center: sceneOriginCenter,
              radiusM: baseGroundRadiusM,
              terrain: terrainStatus,
            })
            terrainRoot?.dispose(false, true)
            terrainRoot = createTerrainSurface(scene, terrainModel)
            if (terrainModel.kind === 'dem') {
              baseWorld.referenceGround.setEnabled(false)
              baseWorld.distantHaze.setEnabled(false)
              config.onWorldStatus?.(`DEM terrain attached · ${terrainModel.minHeightM.toFixed(0)} to ${terrainModel.maxHeightM.toFixed(0)} m`)
            } else {
              baseWorld.referenceGround.setEnabled(true)
              baseWorld.distantHaze.setEnabled(true)
              config.onError?.(`terrain unavailable: ${terrainModel.reason}`)
            }
          }
        } catch (error) {
          terrainStatus = {
            status: 'unavailable',
            reason: error instanceof Error ? error.message : String(error),
          }
          terrainModel = { kind: 'flat', reason: terrainStatus.reason }
          baseWorld.referenceGround.setEnabled(true)
          baseWorld.distantHaze.setEnabled(true)
          config.onError?.(`terrain unavailable: ${terrainStatus.reason}`)
        }
      } else {
        terrainStatus = {
          status: 'unavailable',
          reason: 'scenery artifact was built without DEM terrain alignment',
        }
        terrainModel = { kind: 'flat', reason: terrainStatus.reason }
        baseWorld.referenceGround.setEnabled(true)
        baseWorld.distantHaze.setEnabled(true)
      }
      config.onWorldStatus?.('Preparing road overlay renderer')
      roadOverlayRenderer = createDroneRoadOverlayRenderer({
        scene,
        center: sceneOriginCenter,
        roadTileTemplate: info.roadTileTemplate,
        ...(config.onError === undefined ? {} : { onError: config.onError }),
      })
      config.onWorldStatus?.('Attaching 3D Tiles renderer')
      sceneryRenderer = createDroneSceneryTilesRenderer({
        scene,
        info,
        ...(config.onWorldStatus === undefined ? {} : { onStatus: config.onWorldStatus }),
        ...(config.onError === undefined ? {} : { onError: config.onError }),
        onModelLoaded: (node, modelUrl) => {
          for (const mesh of node.getChildMeshes(false)) tuneImportedSceneryMaterial(mesh)
          roadOverlayRenderer?.attachTileForModelUrl(modelUrl)
        },
        onModelDisposed: modelUrl => roadOverlayRenderer?.disposeTileForModelUrl(modelUrl),
      })
      sceneryLoadMs = performance.now() - startedAt
      config.onWorldStatus?.(`3D Tiles scenery attached · ${info.counts.writtenTileCount} tiles · ${(info.counts.bytes / 1_000_000).toFixed(1)} MB source`)
      notifyReadyOnce()
    } catch (error) {
      if (!destroyed) {
        config.onError?.(error instanceof Error ? error.message : String(error))
        notifyReadyOnce()
      }
    }
  }
  void initializeScenery()

  const ingestMotionFrames = (
    frames: ReadonlyArray<DroneMotionFrame>,
  ): void => {
    const nowMs = performance.now()
    for (const frame of frames) {
      const current = motionFramesByObjectId.get(frame.objectId)
      if (current && frame.sequence <= current.frame.sequence) continue
      motionFramesByObjectId.set(frame.objectId, { frame, receivedAtMs: nowMs })
    }
  }

  const freshMotionPoseFor = (
    object: OperationalObject,
    center: DroneWorldCenter,
    nowMs: number,
  ): ObjectPose | null => {
    const record = motionFramesByObjectId.get(object.id)
    if (!record) return null
    if (nowMs - record.receivedAtMs > motionFrameMaxAgeMs) {
      motionFramesByObjectId.delete(object.id)
      return null
    }
    return poseForMotionFrame(record, object, center, terrainModel)
  }

  const updateObjects = (
    objects: ReadonlyArray<OperationalObject>,
    center: DroneWorldCenter,
    nowMs: number,
    dtSeconds: number,
  ): void => {
    const seen = new Set<string>()
    for (const object of objects) {
      const pose = freshMotionPoseFor(object, center, nowMs) ?? poseFor(object, center, terrainModel, nowMs)
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

  const updateWorldPerformance = (): void => {
    const metrics = sceneryRenderer?.metrics()
    const roadMetrics = roadOverlayRenderer?.metrics()
    const info = sceneryRenderer?.info
    performanceTracker.updateWorld({
      sceneryStage: 'tileset',
      scenerySource: '3d-tiles',
      loadMs: sceneryLoadMs,
      buildMs: 0,
      source: '3d-tiles',
      tiles: metrics?.visibleTiles ?? 0,
      polygons: info?.counts.polygons ?? 0,
      lines: info?.counts.lines ?? 0,
      points: info?.counts.labels ?? 0,
      buildings: info?.counts.buildings ?? 0,
      roads: info?.counts.roads ?? 0,
      roadOverlayTiles: roadMetrics?.loadedRoadTiles ?? 0,
      roadOverlayPendingTiles: roadMetrics?.pendingRoadTiles ?? 0,
      roadOverlayTriangles: roadMetrics?.roadMeshTriangles ?? 0,
      roadOverlayBytes: roadMetrics?.roadMeshBytes ?? 0,
      water: info?.counts.water ?? 0,
      vegetation: info?.counts.vegetation ?? 0,
      roadLabels: 0,
      terrain: terrainLabel(terrainStatus),
      terrainSurface: terrainModel.kind === 'dem' ? 'dem' : 'flat',
    })
  }

  const maybeReportPerformance = (renderStarted: number, nowMs: number): void => {
    updateWorldPerformance()
    const result = performanceTracker.endFrame(nowMs, performance.now() - renderStarted)
    if (!result.shouldReport) return
    const triangles = scene.meshes.reduce((sum, mesh) => sum + (mesh.getTotalIndices() / 3 || 0), 0)
    config.onPerformance?.(performanceTracker.snapshot({
      drawCalls: scene.getActiveMeshes().length,
      triangles: Math.round(triangles),
      geometries: scene.meshes.length,
      textures: scene.textures.length,
      pixelRatio,
      quality: 'balanced',
      activeScenes: activeDroneSceneCount,
    }))
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
    const fallbackCenter = centerFor(objects, config.getFocusDroneId())
    const activeCenter = sceneOriginCenter ?? fallbackCenter
    updateObjects(objects, activeCenter, nowMs, dtSeconds)

    const focusId = config.getFocusDroneId()
    const focus = objectMeshes.get(focusId)
    applyCameraPose(camera, cameraRig, desiredCameraPoseFor(
      cameraTargetFor(objectMeshes, focusId),
      config.getViewMode(),
      focus,
      config.getCameraOrbit(),
    ), dtSeconds)

    sceneryRenderer?.update()
    const renderStarted = performance.now()
    scene.render()
    notifyReadyOnce()
    maybeReportPerformance(renderStarted, performance.now())
  })

  return {
    ingestMotionFrames,
    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      activeDroneSceneCount = Math.max(0, activeDroneSceneCount - 1)
      resizeObserver.disconnect()
      engine.stopRenderLoop()
      for (const entry of objectMeshes.values()) entry.root.dispose(false, true)
      objectMeshes.clear()
      sceneryRenderer?.dispose()
      roadOverlayRenderer?.dispose()
      terrainRoot?.dispose(false, true)
      scene.dispose()
      engine.dispose()
      canvas.remove()
    },
  }
}

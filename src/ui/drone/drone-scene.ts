import * as THREE from 'three'
import type { OperationalObject } from '../../core/model/index.ts'
import { defaultDroneEnvironment, dronePackDataSchema, type DroneEnvironment, type DronePackData } from '../../packs/drone/model.ts'
import { loadDroneMapWorldForScene, type DroneMapWorldLoadResult } from './drone-map-world-loader.ts'
import { createDroneFramePerformanceTracker, type DroneScenePerformanceSnapshot } from './drone-performance.ts'
import { createDroneMapWorldGroup, createFallbackWorldGroup, tickDroneMapWorldGroup } from './drone-world-renderer.ts'

export type DroneSceneViewMode = '3d' | '2d' | 'fpv'
export type { DroneScenePerformanceSnapshot }

export interface DroneSceneHandle {
  readonly destroy: () => void
}

interface DroneSceneConfig {
  readonly container: HTMLElement
  readonly getFocusDroneId: () => string
  readonly getObjects: () => ReadonlyArray<OperationalObject>
  readonly getViewMode: () => DroneSceneViewMode
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

interface MeshEntry {
  readonly signature: string
  readonly mesh: THREE.Group
  readonly visual: VisualPose
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
  readonly position: THREE.Vector3
  readonly rotation: THREE.Euler
  scale: number
}

const metersPerDegreeLat = 111_320
const worldCenterBucketM = 900
const worldStreamPreloadDistanceM = 430
const nearWorldRadiusM = 1_650
const fullWorldRadiusM = 4_250
const droneWorldZoom = 14
let activeDroneSceneCount = 0
const maxDroneScenePixelRatio = 1.15

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

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
  const lon = points.reduce((sum, point) => sum + point.coordinates[0], 0) / points.length
  const lat = points.reduce((sum, point) => sum + point.coordinates[1], 0) / points.length
  return { lon, lat }
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
    y: droneData.success ? droneData.data.kinematics.altitudeM : 1.4,
    z: -(point.coordinates[1] - center.lat) * metersPerDegreeLat,
  }
}

const makeMaterial = (color: string, roughness = 0.68): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 })

const enableShadows = (object: THREE.Object3D): void => {
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true
      child.receiveShadow = true
    }
  })
}

const disposeMaterial = (material: THREE.Material): void => {
  const maybeTextured = material as THREE.Material & {
    readonly map?: THREE.Texture | null
    readonly normalMap?: THREE.Texture | null
    readonly roughnessMap?: THREE.Texture | null
    readonly metalnessMap?: THREE.Texture | null
    readonly emissiveMap?: THREE.Texture | null
    readonly alphaMap?: THREE.Texture | null
  }
  for (const texture of [
    maybeTextured.map,
    maybeTextured.normalMap,
    maybeTextured.roughnessMap,
    maybeTextured.metalnessMap,
    maybeTextured.emissiveMap,
    maybeTextured.alphaMap,
  ]) {
    texture?.dispose()
  }
  material.dispose()
}

const disposeObject = (object: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      geometries.add(child.geometry)
      if (Array.isArray(child.material)) {
        for (const material of child.material) materials.add(material)
      } else {
        materials.add(child.material)
      }
    }
  })
  for (const geometry of geometries) {
    if (geometry.userData.droneSharedWorldGeometry === true) continue
    geometry.dispose()
  }
  for (const material of materials) disposeMaterial(material)
}

const createDroneMesh = (color: string): THREE.Group => {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.38, 1.15),
    makeMaterial(color, 0.42),
  )
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 1.1, 18),
    makeMaterial('#e2e8f0', 0.35),
  )
  nose.rotation.x = Math.PI / 2
  nose.position.z = -0.95
  group.add(body, nose)
  const armMaterial = makeMaterial('#111827', 0.5)
  const rotorMaterial = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.72 })
  for (const [x, z] of [[-1.4, -1.1], [1.4, -1.1], [-1.4, 1.1], [1.4, 1.1]] as const) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 2.6), armMaterial)
    arm.rotation.y = x * z > 0 ? Math.PI / 4 : -Math.PI / 4
    group.add(arm)
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 18), armMaterial)
    motor.position.set(x, 0, z)
    group.add(motor)
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.025, 40), rotorMaterial)
    rotor.position.set(x, 0.12, z)
    rotor.userData.rotor = true
    group.add(rotor)
  }
  enableShadows(group)
  return group
}

const createAmbulanceMesh = (): THREE.Group => {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.7, 2.2), makeMaterial('#f8fafc', 0.56))
  body.position.y = 0.85
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.45, 2.05), makeMaterial('#dbeafe', 0.45))
  cab.position.set(1.65, 1.05, 0)
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.24, 2.24), makeMaterial('#dc2626', 0.5))
  stripe.position.y = 1.2
  const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.04), makeMaterial('#dc2626', 0.5))
  crossA.position.set(-0.7, 1.55, -1.13)
  const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.22, 0.04), makeMaterial('#dc2626', 0.5))
  crossB.position.set(-0.7, 1.55, -1.16)
  group.add(body, cab, stripe, crossA, crossB)
  for (const x of [-1.55, 1.45]) {
    for (const z of [-1.16, 1.16]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18), makeMaterial('#111827', 0.45))
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(x, 0.35, z)
      group.add(wheel)
    }
  }
  enableShadows(group)
  return group
}

const createGenericAssetMesh = (color: string): THREE.Group => {
  const group = new THREE.Group()
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.5, 24), makeMaterial(color, 0.6))
  base.position.y = 0.25
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 18), makeMaterial('#fbbf24', 0.55))
  marker.position.y = 1.3
  group.add(base, marker)
  enableShadows(group)
  return group
}

const meshSignatureFor = (object: OperationalObject): string => {
  const droneData = dronePackDataSchema.safeParse(object.packData)
  if (droneData.success) return `drone:${droneData.data.profile.visual.color}`
  if (object.packId === 'ambulance') return 'ambulance'
  return `asset:${object.operational.priority === 'critical' ? 'critical' : 'normal'}`
}

const createMeshFor = (object: OperationalObject): THREE.Group => {
  const droneData = dronePackDataSchema.safeParse(object.packData)
  if (droneData.success) return createDroneMesh(droneData.data.profile.visual.color)
  if (object.packId === 'ambulance') return createAmbulanceMesh()
  return createGenericAssetMesh(object.operational.priority === 'critical' ? '#dc2626' : '#f59e0b')
}

const focusEnvironment = (
  objects: ReadonlyArray<OperationalObject>,
  focusDroneId: string,
): DroneEnvironment => {
  const focus = objects.find(object => object.id === focusDroneId)
  const parsed = focus ? dronePackDataSchema.safeParse(focus.packData) : null
  return parsed?.success ? parsed.data.environment : defaultDroneEnvironment
}

const updateWeather = (
  weather: THREE.LineSegments,
  environment: DroneEnvironment,
  frame: number,
): void => {
  const active = environment.precipitation !== 'none' && environment.precipitationIntensity > 0.03
  weather.visible = active
  if (!active) return
  const geometry = weather.geometry
  const position = geometry.getAttribute('position')
  if (!(position instanceof THREE.BufferAttribute)) return
  const count = position.count / 2
  const fall = environment.precipitation === 'snow' ? 0.55 : 1.9
  const slant = environment.windSpeedMps * 0.14
  for (let index = 0; index < count; index += 1) {
    const seed = index * 97.13
    const x = ((seed * 17 + frame * slant) % 700) - 350
    const y = 20 + ((seed * 29 - frame * fall) % 260 + 260) % 260
    const z = ((seed * 43 + frame * 0.6) % 700) - 350
    position.setXYZ(index * 2, x, y, z)
    position.setXYZ(index * 2 + 1, x - slant * 1.6, y - (environment.precipitation === 'snow' ? 1.6 : 8.5), z + 0.6)
  }
  position.needsUpdate = true
}

const createWeatherLayer = (): THREE.LineSegments => {
  const count = 180
  const positions = new Float32Array(count * 2 * 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({ color: '#dbeafe', transparent: true, opacity: 0.62 })
  const lines = new THREE.LineSegments(geometry, material)
  lines.frustumCulled = false
  lines.visible = false
  return lines
}

const setFogFor = (scene: THREE.Scene, environment: DroneEnvironment): void => {
  const near = clamp(environment.visibilityM * 0.08, 120, 900)
  const far = clamp(environment.visibilityM * 0.62, 420, 5_000)
  scene.fog = new THREE.Fog('#94a3b8', near, far)
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

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
}

export const droneWorldLoadSpecsFor = (
  _reason: DroneWorldStreamDecision['reason'],
): ReadonlyArray<DroneWorldLoadSpec> => [
  { stage: 'near', radiusM: nearWorldRadiusM, zoom: droneWorldZoom },
  { stage: 'full', radiusM: fullWorldRadiusM, zoom: droneWorldZoom },
]

export const nextDroneWorldStreamDecision = (config: {
  readonly currentCenter: { readonly lon: number; readonly lat: number } | null
  readonly currentCenterKey: string
  readonly pendingCenterKey: string
  readonly desiredCenter: { readonly lon: number; readonly lat: number }
}): DroneWorldStreamDecision | null => {
  const nextCenter = bucketWorldCenter(config.desiredCenter)
  const nextKey = worldCenterKeyFor(nextCenter)
  if (config.currentCenter === null) {
    return {
      center: nextCenter,
      key: nextKey,
      reason: 'initial',
    }
  }
  if (nextKey === config.currentCenterKey || nextKey === config.pendingCenterKey) return null
  if (centerDistanceM(config.currentCenter, config.desiredCenter) < worldStreamPreloadDistanceM) return null
  return {
    center: nextCenter,
    key: nextKey,
    reason: 'grid-crossing',
  }
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
  const yawDeg = data?.kinematics.yawDeg ?? 0
  const manualYawRateDegPerSec = data?.control.mode === 'manual' && data.control.manualAxes
    ? data.control.manualAxes.yaw * data.profile.dynamics.maxYawRateDegPerSec
    : 0
  return {
    key: `${object.revision}:${object.timestamps.updatedAt}:${center.lon.toFixed(6)}:${center.lat.toFixed(6)}`,
    local,
    yawRad: yawDeg * Math.PI / 180,
    pitchRad: (data?.kinematics.pitchDeg ?? 0) * Math.PI / 180,
    rollRad: -(data?.kinematics.rollDeg ?? 0) * Math.PI / 180,
    scale: data?.profile.visual.scale ?? 1,
    velocityEastMps: data?.kinematics.velocityEastMps ?? 0,
    velocityNorthMps: data?.kinematics.velocityNorthMps ?? 0,
    verticalSpeedMps: data?.kinematics.verticalSpeedMps ?? 0,
    yawRateRadPerSec: manualYawRateDegPerSec * Math.PI / 180,
    receivedAtMs,
    data,
  }
}

const predictedPose = (
  pose: ObjectPose,
  nowMs: number,
): {
  readonly position: THREE.Vector3
  readonly yawRad: number
  readonly pitchRad: number
  readonly rollRad: number
  readonly scale: number
} => {
  const elapsedSeconds = clamp((nowMs - pose.receivedAtMs) / 1000, 0, 0.32)
  return {
    position: new THREE.Vector3(
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

const shortestAngleDeltaRad = (
  from: number,
  to: number,
): number => {
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
  const distance = visual.position.distanceTo(desired.position)
  const shouldSnap = reset || distance > 160
  const alpha = shouldSnap ? 1 : 1 - Math.exp(-dtSeconds * (viewMode === 'fpv' ? 18 : 10))
  visual.position.lerp(desired.position, alpha)
  visual.rotation.y += shortestAngleDeltaRad(visual.rotation.y, desired.yawRad) * alpha
  visual.rotation.x += shortestAngleDeltaRad(visual.rotation.x, desired.pitchRad) * alpha
  visual.rotation.z += shortestAngleDeltaRad(visual.rotation.z, desired.rollRad) * alpha
  visual.scale += (desired.scale - visual.scale) * alpha
}

const applyCameraProjection = (
  camera: THREE.PerspectiveCamera,
  config: { readonly fov: number; readonly near: number; readonly far: number },
): void => {
  if (camera.fov === config.fov && camera.near === config.near && camera.far === config.far) return
  camera.fov = config.fov
  camera.near = config.near
  camera.far = config.far
  camera.updateProjectionMatrix()
}

export const createDroneScene = (config: DroneSceneConfig): DroneSceneHandle => {
  activeDroneSceneCount += 1
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#94a3b8')
  const camera = new THREE.PerspectiveCamera(58, 1, 0.25, 5_000)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  let renderQuality: DroneScenePerformanceSnapshot['quality'] = 'balanced'
  let pixelRatio = Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio)
  renderer.setPixelRatio(pixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  config.container.appendChild(renderer.domElement)
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
  keyLight.position.set(-160, 450, 220)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.width = 1024
  keyLight.shadow.mapSize.height = 1024
  keyLight.shadow.camera.near = 10
  keyLight.shadow.camera.far = 1_200
  keyLight.shadow.camera.left = -520
  keyLight.shadow.camera.right = 520
  keyLight.shadow.camera.top = 520
  keyLight.shadow.camera.bottom = -520
  const ambient = new THREE.HemisphereLight('#dbeafe', '#475569', 1.08)
  scene.add(keyLight, ambient)
  let environmentLayer = createFallbackWorldGroup()
  scene.add(environmentLayer)
  const objectLayer = new THREE.Group()
  scene.add(objectLayer)
  const weatherLayer = createWeatherLayer()
  scene.add(weatherLayer)
  const objectMeshes = new Map<string, MeshEntry>()
  let worldCenter: { readonly lon: number; readonly lat: number } | null = null
  let worldCenterKey = ''
  let pendingWorldCenterKey = ''
  let worldRecenterRevision = 0
  let renderedWorldRecenterRevision = 0
  let worldLoadGeneration = 0
  let destroyed = false
  const performanceTracker = createDroneFramePerformanceTracker()
  const applyPixelRatio = (nextRatio: number, nextQuality: DroneScenePerformanceSnapshot['quality']): void => {
    const clamped = clamp(nextRatio, 0.9, Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio))
    if (Math.abs(clamped - pixelRatio) < 0.03 && nextQuality === renderQuality) return
    pixelRatio = clamped
    renderQuality = nextQuality
    renderer.setPixelRatio(pixelRatio)
    resize()
  }
  const maybeAdaptQuality = (snapshot: DroneScenePerformanceSnapshot): void => {
    if (snapshot.frameP95Ms > 46 && pixelRatio > 1) {
      applyPixelRatio(pixelRatio - 0.18, 'rescue')
      return
    }
    if (snapshot.frameP95Ms > 30 && pixelRatio > 1.1) {
      applyPixelRatio(pixelRatio - 0.1, 'balanced')
      return
    }
    if (snapshot.frameP95Ms < 18 && pixelRatio < Math.min(window.devicePixelRatio || 1, maxDroneScenePixelRatio)) {
      applyPixelRatio(pixelRatio + 0.04, 'balanced')
    }
  }
  let readyNotified = false
  const notifyReadyOnce = (): void => {
    if (readyNotified) return
    readyNotified = true
    config.onReady?.()
  }
  const worldStatusFor = (config: {
    readonly stage: DroneWorldLoadStage
    readonly worldResult: DroneMapWorldLoadResult
  }): string => {
    const snapshot = config.worldResult.snapshot
    const fallbackSuffix = config.worldResult.fallbackReason ? `; worker fallback: ${config.worldResult.fallbackReason}` : ''
    const terrainSuffix = config.worldResult.terrain.status === 'available'
      ? `; terrain ${config.worldResult.terrain.demEncoding}/${config.worldResult.terrainModel.kind}`
      : `; terrain ${config.worldResult.terrain.status}`
    const coverageSuffix = `; ${snapshot.coverage.selected.buildings} buildings, ${snapshot.coverage.selected.roads} roads, ${snapshot.coverage.selected.waterPolygons + snapshot.coverage.selected.waterways} water features, ${snapshot.coverage.selected.vegetationPolygons} vegetation areas`
    const noteSuffix = snapshot.coverage.notes.length > 0 ? `; ${snapshot.coverage.notes[0]}` : ''
    const stageLabel = config.stage === 'near' ? 'Nearby map scenery' : 'Full map scenery'
    const enrichmentSuffix = config.stage === 'near' ? '; loading full operating area' : ''
    return `${stageLabel} loaded via ${config.worldResult.source}: ${snapshot.tileCount} tiles, ${snapshot.polygons.length} polygons, ${snapshot.lines.length} lines${coverageSuffix}${terrainSuffix}${fallbackSuffix}${noteSuffix}${enrichmentSuffix}`
  }
  const applyWorldResult = (result: {
    readonly center: { readonly lon: number; readonly lat: number }
    readonly loadedCenterKey: string
    readonly stage: DroneWorldLoadStage
    readonly worldResult: DroneMapWorldLoadResult
    readonly loadMs: number
  }): void => {
    const snapshot = result.worldResult.snapshot
    const buildStartedAtMs = performance.now()
    const nextLayer = createDroneMapWorldGroup(snapshot, result.worldResult.terrainModel)
    const buildMs = performance.now() - buildStartedAtMs
    scene.remove(environmentLayer)
    disposeObject(environmentLayer)
    environmentLayer = nextLayer
    scene.add(environmentLayer)
    worldCenter = result.center
    worldCenterKey = result.loadedCenterKey
    pendingWorldCenterKey = ''
    worldRecenterRevision += 1
    performanceTracker.updateWorld({
      sceneryStage: result.stage,
      loadMs: result.loadMs,
      buildMs,
      source: result.worldResult.source,
      tiles: snapshot.tileCount,
      polygons: snapshot.polygons.length,
      lines: snapshot.lines.length,
      points: snapshot.points.length,
      buildings: snapshot.coverage.selected.buildings,
      roads: snapshot.coverage.selected.roads,
      water: snapshot.coverage.selected.waterPolygons + snapshot.coverage.selected.waterways,
      vegetation: snapshot.coverage.selected.vegetationPolygons,
      roadLabels: snapshot.coverage.selected.roadLabels,
      lineFragmentsMerged: snapshot.coverage.lineFragmentsMerged,
      terrain: result.worldResult.terrain.status,
      terrainSurface: result.worldResult.terrainModel.kind,
    })
    notifyReadyOnce()
    config.onWorldStatus?.(worldStatusFor({ stage: result.stage, worldResult: result.worldResult }))
  }
  const loadWorldFor = (decision: DroneWorldStreamDecision): void => {
    const generation = ++worldLoadGeneration
    const loadedCenterKey = decision.key
    config.onWorldStatus?.('Loading nearby map-derived scenery')
    void (async (): Promise<void> => {
      for (const spec of droneWorldLoadSpecsFor(decision.reason)) {
        try {
          const loadStartedAtMs = performance.now()
          const worldResult = await loadDroneMapWorldForScene({
            center: decision.center,
            radiusM: spec.radiusM,
            zoom: spec.zoom,
          })
          const loadMs = performance.now() - loadStartedAtMs
          if (destroyed || generation !== worldLoadGeneration) return
          applyWorldResult({
            center: decision.center,
            loadedCenterKey,
            stage: spec.stage,
            worldResult,
            loadMs,
          })
        } catch (err) {
          if (destroyed || generation !== worldLoadGeneration) return
          pendingWorldCenterKey = ''
          const message = err instanceof Error ? err.message : String(err)
          if (spec.stage === 'near') {
            config.onWorldStatus?.(`Map scenery unavailable: ${message}`)
            return
          }
          config.onWorldStatus?.(`Full map scenery unavailable; keeping nearby scenery: ${message}`)
          return
        }
      }
    })()
  }
  const resize = (): void => {
    const rect = config.container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(config.container)
  resize()
  let frame = 0
  let animationId = 0
  let lastFrameMs = performance.now()
  const render = (): void => {
    const frameStartedAtMs = performance.now()
    const viewMode = config.getViewMode()
    performanceTracker.beginFrame(frameStartedAtMs)
    const dtSeconds = clamp((frameStartedAtMs - lastFrameMs) / 1000, 0.001, 0.08)
    lastFrameMs = frameStartedAtMs
    frame += 1
    const objects = config.getObjects()
    const focusDroneId = config.getFocusDroneId()
    const desiredCenter = centerFor(objects, focusDroneId)
    const streamDecision = nextDroneWorldStreamDecision({
      currentCenter: worldCenter,
      currentCenterKey: worldCenterKey,
      pendingCenterKey: pendingWorldCenterKey,
      desiredCenter,
    })
    if (streamDecision) {
      if (streamDecision.reason === 'initial') {
        worldCenter = streamDecision.center
        worldCenterKey = streamDecision.key
      } else {
        pendingWorldCenterKey = streamDecision.key
      }
      loadWorldFor(streamDecision)
    }
    const recentered = renderedWorldRecenterRevision !== worldRecenterRevision
    renderedWorldRecenterRevision = worldRecenterRevision
    const center = worldCenter ?? desiredCenter
    const environment = focusEnvironment(objects, focusDroneId)
    setFogFor(scene, environment)
    tickDroneMapWorldGroup(environmentLayer, frameStartedAtMs, viewMode)
    updateWeather(weatherLayer, environment, frame)
    let focusPoint: LocalPoint | null = null
    let focusData: DronePackData | null = null
    const liveIds = new Set<string>(objects.map(object => object.id))
    for (const [id, entry] of objectMeshes) {
      if (liveIds.has(id)) continue
      disposeObject(entry.mesh)
      objectLayer.remove(entry.mesh)
      objectMeshes.delete(id)
    }
    for (const object of objects) {
      const pose = poseFor(object, center, frameStartedAtMs)
      if (!pose) continue
      const droneData = dronePackDataSchema.safeParse(object.packData)
      const signature = meshSignatureFor(object)
      const existing = objectMeshes.get(object.id)
      const entry = existing?.signature === signature
        ? existing
        : (() => {
            if (existing) {
              disposeObject(existing.mesh)
              objectLayer.remove(existing.mesh)
            }
            const mesh = createMeshFor(object)
            objectLayer.add(mesh)
            const next = {
              signature,
              mesh,
              visual: {
                target: pose,
                position: new THREE.Vector3(pose.local.x, pose.local.y, pose.local.z),
                rotation: new THREE.Euler(pose.pitchRad, pose.yawRad, pose.rollRad, 'YXZ'),
                scale: pose.scale,
              },
            }
            objectMeshes.set(object.id, next)
            return next
          })()
      if (entry.visual.target.key !== pose.key) entry.visual.target = pose
      const desired = predictedPose(entry.visual.target, frameStartedAtMs)
      smoothVisualPose(entry.visual, desired, dtSeconds, recentered, viewMode)
      const mesh = entry.mesh
      mesh.position.copy(entry.visual.position)
      mesh.rotation.order = 'YXZ'
      mesh.rotation.copy(entry.visual.rotation)
      mesh.scale.setScalar(entry.visual.scale)
      mesh.traverse(child => {
        if (child.userData.rotor === true) child.rotation.y += 1.8
      })
      if (object.id === focusDroneId) {
        focusPoint = {
          x: entry.visual.position.x,
          y: entry.visual.position.y,
          z: entry.visual.position.z,
        }
        focusData = droneData.success ? droneData.data : null
      }
    }
    const focus = focusPoint ?? { x: 0, y: 35, z: 0 }
    camera.up.set(0, 1, 0)
    if (viewMode === '2d') {
      const cameraHeight = Math.max(300, focus.y + 560)
      applyCameraProjection(camera, { fov: 42, near: 80, far: 1_850 })
      camera.position.set(focus.x, cameraHeight, focus.z + 0.1)
      camera.lookAt(focus.x, 0, focus.z)
    } else if (viewMode === 'fpv' && focusData) {
      applyCameraProjection(camera, { fov: 82, near: 0.18, far: 4_500 })
      const yawRad = focusData.kinematics.yawDeg * Math.PI / 180
      const pitchRad = focusData.kinematics.pitchDeg * Math.PI / 180
      const rollRad = focusData.kinematics.rollDeg * Math.PI / 180
      const forwardX = Math.sin(yawRad)
      const forwardZ = -Math.cos(yawRad)
      camera.position.set(
        focus.x + forwardX * 1.1,
        focus.y + 0.22,
        focus.z + forwardZ * 1.1,
      )
      const lookDistance = 120
      camera.lookAt(
        camera.position.x + Math.sin(yawRad) * Math.cos(pitchRad) * lookDistance,
        camera.position.y + Math.sin(-pitchRad) * lookDistance,
        camera.position.z - Math.cos(yawRad) * Math.cos(pitchRad) * lookDistance,
      )
      camera.rotateZ(-rollRad)
    } else {
      applyCameraProjection(camera, { fov: 58, near: 1.5, far: 3_200 })
      camera.position.set(focus.x - 85, focus.y + 46, focus.z + 115)
      camera.lookAt(focus.x, focus.y + 2, focus.z)
    }
    try {
      const renderStartedAtMs = performance.now()
      renderer.render(scene, camera)
      const renderFinishedAtMs = performance.now()
      const frameFinishedAtMs = performance.now()
      const frameResult = performanceTracker.endFrame(frameFinishedAtMs, renderFinishedAtMs - renderStartedAtMs)
      if (frameResult.shouldReport) {
        const snapshot = performanceTracker.snapshot({
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          pixelRatio,
          quality: renderQuality,
          activeScenes: activeDroneSceneCount,
        })
        maybeAdaptQuality(snapshot)
        config.onPerformance?.(snapshot)
      }
    } catch (err) {
      config.onError?.(err instanceof Error ? err.message : String(err))
    }
    animationId = requestAnimationFrame(render)
  }
  animationId = requestAnimationFrame(render)
  return {
    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      activeDroneSceneCount = Math.max(0, activeDroneSceneCount - 1)
      cancelAnimationFrame(animationId)
      observer.disconnect()
      disposeObject(environmentLayer)
      disposeObject(objectLayer)
      disposeObject(weatherLayer)
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

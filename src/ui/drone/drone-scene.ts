import * as THREE from 'three'
import type { OperationalObject } from '../../core/model/index.ts'
import { defaultDroneEnvironment, dronePackDataSchema, type DroneEnvironment, type DronePackData } from '../../packs/drone/model.ts'

export type DroneSceneViewMode = '3d' | '2d' | 'fpv'

export interface DroneSceneHandle {
  readonly destroy: () => void
}

interface DroneSceneConfig {
  readonly container: HTMLElement
  readonly focusDroneId: string
  readonly getObjects: () => ReadonlyArray<OperationalObject>
  readonly getViewMode: () => DroneSceneViewMode
  readonly onReady?: () => void
  readonly onError?: (message: string) => void
}

interface LocalPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface MeshEntry {
  readonly signature: string
  readonly mesh: THREE.Group
}

const metersPerDegreeLat = 111_320

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
  for (const geometry of geometries) geometry.dispose()
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

const deterministicHeight = (x: number, z: number): number => {
  const value = Math.sin(x * 0.017 + 2.1) * Math.cos(z * 0.013 - 1.7)
  return 5 + Math.abs(value) * 26
}

const addProceduralEnvironment = (scene: THREE.Scene): THREE.Group => {
  const group = new THREE.Group()
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1_800, 1_800, 32, 32),
    new THREE.MeshStandardMaterial({ color: '#64748b', roughness: 0.92, metalness: 0.02 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.02
  ground.receiveShadow = true
  group.add(ground)
  const park = new THREE.Mesh(
    new THREE.CircleGeometry(170, 48),
    new THREE.MeshStandardMaterial({ color: '#166534', roughness: 0.9, transparent: true, opacity: 0.82 }),
  )
  park.rotation.x = -Math.PI / 2
  park.position.set(-180, 0.01, 120)
  group.add(park)
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1_800, 220),
    new THREE.MeshStandardMaterial({ color: '#0e7490', roughness: 0.45, metalness: 0.05, transparent: true, opacity: 0.72 }),
  )
  water.rotation.x = -Math.PI / 2
  water.position.set(0, 0.02, 420)
  group.add(water)
  const roadMaterial = new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.86 })
  const laneMaterial = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.72 })
  for (const [x, z, rot, length, width] of [
    [0, 0, 0.12, 1_600, 18],
    [-260, -120, -0.58, 1_200, 14],
    [280, 90, 0.8, 1_050, 12],
    [40, -310, Math.PI / 2, 1_400, 16],
  ] as const) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(width, length), roadMaterial)
    road.rotation.x = -Math.PI / 2
    road.rotation.z = rot
    road.position.set(x, 0.04, z)
    group.add(road)
    for (let offset = -length / 2 + 32; offset < length / 2; offset += 64) {
      const lane = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 22), laneMaterial)
      lane.rotation.x = -Math.PI / 2
      lane.rotation.z = rot
      lane.position.set(
        x + Math.sin(rot) * offset,
        0.055,
        z + Math.cos(rot) * offset,
      )
      group.add(lane)
    }
  }
  const buildingMaterial = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.74, metalness: 0.03 })
  const roofMaterial = new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.8 })
  const windowMaterial = new THREE.MeshStandardMaterial({ color: '#dbeafe', roughness: 0.5, metalness: 0.04, emissive: '#1e3a8a', emissiveIntensity: 0.08 })
  for (let x = -760; x <= 760; x += 95) {
    for (let z = -720; z <= 300; z += 95) {
      const skip = Math.abs(x) < 65 || Math.abs(z) < 50 || Math.hypot(x + 180, z - 120) < 200
      if (skip) continue
      const height = deterministicHeight(x, z)
      const building = new THREE.Mesh(new THREE.BoxGeometry(42, height, 48), buildingMaterial)
      building.position.set(x + Math.sin(z) * 6, height / 2, z + Math.cos(x) * 6)
      const roof = new THREE.Mesh(new THREE.BoxGeometry(44, 0.8, 50), roofMaterial)
      roof.position.set(building.position.x, height + 0.45, building.position.z)
      group.add(building, roof)
      for (let floor = 4; floor < height - 2; floor += 5.5) {
        for (const side of [-1, 1]) {
          const windows = new THREE.Mesh(new THREE.BoxGeometry(30, 1.2, 0.08), windowMaterial)
          windows.position.set(building.position.x, floor, building.position.z + side * 24.04)
          group.add(windows)
        }
      }
    }
  }
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#7c2d12', roughness: 0.86 })
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: '#15803d', roughness: 0.92 })
  for (let index = 0; index < 90; index += 1) {
    const angle = index * 2.39996
    const radius = 75 + (index % 9) * 14
    const x = -180 + Math.cos(angle) * radius
    const z = 120 + Math.sin(angle) * radius
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 5, 8), trunkMaterial)
    trunk.position.set(x, 2.5, z)
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(4.4 + (index % 3), 12, 8), canopyMaterial)
    canopy.position.set(x, 7.5, z)
    group.add(trunk, canopy)
  }
  enableShadows(group)
  scene.add(group)
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

export const createDroneScene = (config: DroneSceneConfig): DroneSceneHandle => {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#94a3b8')
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 5_000)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  config.container.appendChild(renderer.domElement)
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
  keyLight.position.set(-160, 450, 220)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.width = 2048
  keyLight.shadow.mapSize.height = 2048
  keyLight.shadow.camera.near = 10
  keyLight.shadow.camera.far = 1_200
  keyLight.shadow.camera.left = -650
  keyLight.shadow.camera.right = 650
  keyLight.shadow.camera.top = 650
  keyLight.shadow.camera.bottom = -650
  const ambient = new THREE.HemisphereLight('#dbeafe', '#475569', 1.25)
  scene.add(keyLight, ambient)
  const environmentLayer = addProceduralEnvironment(scene)
  const objectLayer = new THREE.Group()
  scene.add(objectLayer)
  const weatherLayer = createWeatherLayer()
  scene.add(weatherLayer)
  const objectMeshes = new Map<string, MeshEntry>()
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
  let readyNotified = false
  let animationId = 0
  const render = (): void => {
    frame += 1
    const objects = config.getObjects()
    const center = centerFor(objects, config.focusDroneId)
    const environment = focusEnvironment(objects, config.focusDroneId)
    setFogFor(scene, environment)
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
      const local = localPointFor(object, center)
      if (!local) continue
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
            const next = { signature, mesh }
            objectMeshes.set(object.id, next)
            return next
          })()
      const mesh = entry.mesh
      mesh.position.set(local.x, local.y, local.z)
      mesh.rotation.order = 'YXZ'
      mesh.rotation.y = droneData.success ? droneData.data.kinematics.yawDeg * Math.PI / 180 : 0
      mesh.rotation.x = droneData.success ? droneData.data.kinematics.pitchDeg * Math.PI / 180 : 0
      mesh.rotation.z = droneData.success ? -droneData.data.kinematics.rollDeg * Math.PI / 180 : 0
      mesh.scale.setScalar(droneData.success ? droneData.data.profile.visual.scale : 1)
      mesh.traverse(child => {
        if (child.userData.rotor === true) child.rotation.y += 1.8
      })
      if (object.id === config.focusDroneId) {
        focusPoint = local
        focusData = droneData.success ? droneData.data : null
      }
    }
    const focus = focusPoint ?? { x: 0, y: 35, z: 0 }
    camera.up.set(0, 1, 0)
    if (config.getViewMode() === '2d') {
      if (camera.fov !== 46) {
        camera.fov = 46
        camera.updateProjectionMatrix()
      }
      camera.position.set(focus.x, Math.max(260, focus.y + 520), focus.z + 0.1)
      camera.lookAt(focus.x, 0, focus.z)
    } else if (config.getViewMode() === 'fpv' && focusData) {
      if (camera.fov !== 82) {
        camera.fov = 82
        camera.updateProjectionMatrix()
      }
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
      if (camera.fov !== 58) {
        camera.fov = 58
        camera.updateProjectionMatrix()
      }
      camera.position.set(focus.x - 85, focus.y + 46, focus.z + 115)
      camera.lookAt(focus.x, focus.y + 2, focus.z)
    }
    try {
      renderer.render(scene, camera)
      if (!readyNotified && frame > 2) {
        readyNotified = true
        config.onReady?.()
      }
    } catch (err) {
      config.onError?.(err instanceof Error ? err.message : String(err))
    }
    animationId = requestAnimationFrame(render)
  }
  animationId = requestAnimationFrame(render)
  return {
    destroy: (): void => {
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

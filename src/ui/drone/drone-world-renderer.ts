import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldPoint,
  DroneWorldPolygonFeature,
} from './drone-map-world.ts'
import { createTransportGeometryGroup } from './drone-transport-renderer.ts'

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const makeMaterial = (
  color: string,
  roughness = 0.72,
  metalness = 0.04,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })

const surfacePalette = (
  feature: DroneWorldPolygonFeature,
): string => {
  if (feature.kind === 'water') return '#1d8fb8'
  if (feature.className === 'wood' || feature.className === 'forest') return '#1f6f3a'
  if (feature.className === 'grass' || feature.className === 'park') return '#5d9b45'
  if (feature.className === 'wetland') return '#4f8a7a'
  if (feature.className === 'sand') return '#d7c88f'
  if (feature.className === 'hospital') return '#cbdff8'
  if (feature.className === 'industrial') return '#b9afa6'
  if (feature.className === 'commercial') return '#cbc2b1'
  return '#9aae88'
}

const polygonArea = (ring: ReadonlyArray<DroneWorldPoint>): number => {
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

const shapeFor = (
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
): THREE.Shape | null => {
  const outer = rings[0]
  if (!outer || outer.length < 3 || Math.abs(polygonArea(outer)) < 2) return null
  const shape = new THREE.Shape()
  shape.moveTo(outer[0]!.x, -outer[0]!.z)
  for (const point of outer.slice(1)) shape.lineTo(point.x, -point.z)
  shape.closePath()
  for (const holeRing of rings.slice(1)) {
    if (holeRing.length < 3) continue
    const hole = new THREE.Path()
    hole.moveTo(holeRing[0]!.x, -holeRing[0]!.z)
    for (const point of holeRing.slice(1)) hole.lineTo(point.x, -point.z)
    hole.closePath()
    shape.holes.push(hole)
  }
  return shape
}

const createGroundTexture = (): THREE.Texture | null => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = context.createImageData(canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = index / 4
    const x = pixel % canvas.width
    const y = Math.floor(pixel / canvas.width)
    const noise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const grain = Math.floor((noise - Math.floor(noise)) * 20)
    image.data[index] = 92 + grain
    image.data[index + 1] = 112 + grain
    image.data[index + 2] = 93 + grain
    image.data[index + 3] = 255
  }
  context.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(18, 18)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const createBaseGround = (
  radiusM: number,
): THREE.Mesh => {
  const texture = createGroundTexture()
  const material = new THREE.MeshStandardMaterial({
    color: '#6d7f62',
    roughness: 0.95,
    metalness: 0.01,
    ...(texture === null ? {} : { map: texture }),
  })
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radiusM * 2.6, radiusM * 2.6, 1, 1), material)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.05
  ground.receiveShadow = true
  return ground
}

interface GeometryBucket {
  readonly material: THREE.Material
  readonly geometries: THREE.BufferGeometry[]
  readonly receiveShadow: boolean
  readonly castShadow: boolean
}

const addBucketGeometry = (
  buckets: Map<string, GeometryBucket>,
  key: string,
  material: THREE.Material,
  geometry: THREE.BufferGeometry,
  config: { readonly receiveShadow: boolean; readonly castShadow: boolean },
): void => {
  const existing = buckets.get(key)
  if (existing) {
    existing.geometries.push(geometry)
    material.dispose()
    return
  }
  buckets.set(key, {
    material,
    geometries: [geometry],
    receiveShadow: config.receiveShadow,
    castShadow: config.castShadow,
  })
}

const mergeGeometries = (
  geometries: ReadonlyArray<THREE.BufferGeometry>,
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  let vertexOffset = 0
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position')
    if (!(position instanceof THREE.BufferAttribute) || position.count === 0) {
      geometry.dispose()
      continue
    }
    for (let index = 0; index < position.count; index += 1) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index))
    }
    const geometryIndex = geometry.getIndex()
    if (geometryIndex) {
      for (let index = 0; index < geometryIndex.count; index += 1) {
        indices.push(geometryIndex.getX(index) + vertexOffset)
      }
    } else {
      for (let index = 0; index < position.count; index += 1) {
        indices.push(vertexOffset + index)
      }
    }
    vertexOffset += position.count
    geometry.dispose()
  }
  if (positions.length === 0 || indices.length === 0) return null
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setIndex(indices)
  merged.computeVertexNormals()
  merged.computeBoundingSphere()
  return merged
}

const meshesFromBuckets = (
  buckets: ReadonlyMap<string, GeometryBucket>,
): THREE.Group => {
  const group = new THREE.Group()
  for (const bucket of buckets.values()) {
    const geometry = mergeGeometries(bucket.geometries)
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, bucket.material)
    mesh.receiveShadow = bucket.receiveShadow
    mesh.castShadow = bucket.castShadow
    group.add(mesh)
  }
  return group
}

const createMergedSurfaceMeshes = (
  polygons: ReadonlyArray<DroneWorldPolygonFeature>,
): THREE.Group => {
  const buckets = new Map<string, GeometryBucket>()
  for (const feature of polygons) {
    if (feature.kind === 'building') continue
    const shape = shapeFor(feature.rings)
    if (!shape) continue
    const color = surfacePalette(feature)
    const isWater = feature.kind === 'water'
    const geometry = new THREE.ShapeGeometry(shape, 4)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, isWater ? 0.035 : 0.01, 0)
    addBucketGeometry(
      buckets,
      `${feature.kind}:${feature.className}:${color}`,
      new THREE.MeshStandardMaterial({
        color,
        roughness: isWater ? 0.45 : 0.9,
        metalness: isWater ? 0.08 : 0.01,
        transparent: isWater,
        opacity: isWater ? 0.82 : 0.88,
      }),
      geometry,
      { receiveShadow: true, castShadow: false },
    )
  }
  return meshesFromBuckets(buckets)
}

const createMergedBuildingMeshes = (
  polygons: ReadonlyArray<DroneWorldPolygonFeature>,
): THREE.Group => {
  const buckets = new Map<string, GeometryBucket>()
  for (const feature of polygons) {
    if (feature.kind !== 'building') continue
    const shape = shapeFor(feature.rings)
    const height = feature.heightM ?? 8
    if (!shape || height < 1) continue
    const minHeight = feature.minHeightM ?? 0
    const wallColor = feature.className === 'industrial'
      ? '#a8a29e'
      : feature.className === 'commercial'
        ? '#b8b4a7'
        : '#c9c4ba'
    const wallGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
    })
    wallGeometry.rotateX(-Math.PI / 2)
    wallGeometry.translate(0, minHeight, 0)
    addBucketGeometry(
      buckets,
      `building-wall:${feature.className}:${wallColor}`,
      makeMaterial(wallColor, 0.76, 0.03),
      wallGeometry,
      { receiveShadow: true, castShadow: false },
    )

    const roofGeometry = new THREE.ShapeGeometry(shape, 4)
    roofGeometry.rotateX(-Math.PI / 2)
    roofGeometry.translate(0, minHeight + height + 0.08, 0)
    addBucketGeometry(
      buckets,
      'building-roof:#6b7280',
      makeMaterial('#6b7280', 0.84, 0.02),
      roofGeometry,
      { receiveShadow: true, castShadow: false },
    )
  }
  return meshesFromBuckets(buckets)
}

const seededRandom = (
  seed: number,
): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = Math.imul(1664525, state) + 1013904223
    return (state >>> 0) / 0xffffffff
  }
}

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const polygonBounds = (
  ring: ReadonlyArray<DroneWorldPoint>,
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

const vegetationFeatures = (
  snapshot: DroneMapWorldSnapshot,
): ReadonlyArray<DroneWorldPolygonFeature> =>
  snapshot.polygons.filter(feature =>
    (feature.kind === 'landcover' || feature.kind === 'landuse')
    && ['wood', 'forest', 'grass', 'park', 'residential'].includes(feature.className))

const createVegetation = (
  snapshot: DroneMapWorldSnapshot,
): THREE.Group => {
  const features = vegetationFeatures(snapshot)
  const group = new THREE.Group()
  const maxTrees = 420
  const positions: Array<{ readonly x: number; readonly z: number; readonly scale: number }> = []
  for (const feature of features) {
    const outer = feature.rings[0]
    if (!outer || outer.length < 3 || positions.length >= maxTrees) continue
    const bounds = polygonBounds(outer)
    const area = Math.abs(polygonArea(outer))
    const targetCount = clamp(Math.floor(area / (feature.className === 'residential' ? 18_000 : 7_500)), 2, 42)
    const random = seededRandom(stableHash(feature.id))
    let added = 0
    for (let attempt = 0; attempt < targetCount * 12 && positions.length < maxTrees && added < targetCount; attempt += 1) {
      const candidate = {
        x: bounds.minX + random() * (bounds.maxX - bounds.minX),
        z: bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
      }
      if (!pointInRing(candidate, outer)) continue
      positions.push({
        x: candidate.x,
        z: candidate.z,
        scale: 0.75 + random() * 0.85,
      })
      added += 1
    }
  }
  if (positions.length === 0) return group
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.55, 0.78, 5.2, 7),
    makeMaterial('#6f3d1d', 0.9, 0.01),
    positions.length,
  )
  const canopy = new THREE.InstancedMesh(
    new THREE.ConeGeometry(3.2, 8.5, 9),
    makeMaterial('#1f7a3a', 0.88, 0.01),
    positions.length,
  )
  const dummy = new THREE.Object3D()
  for (const [index, position] of positions.entries()) {
    dummy.position.set(position.x, 2.6 * position.scale, position.z)
    dummy.scale.set(position.scale, position.scale, position.scale)
    dummy.rotation.y = stableHash(`${position.x}:${position.z}`) / 0xffffffff * Math.PI * 2
    dummy.updateMatrix()
    trunk.setMatrixAt(index, dummy.matrix)
    dummy.position.set(position.x, 7.5 * position.scale, position.z)
    dummy.updateMatrix()
    canopy.setMatrixAt(index, dummy.matrix)
  }
  trunk.receiveShadow = true
  trunk.castShadow = false
  canopy.castShadow = false
  canopy.receiveShadow = true
  group.add(trunk, canopy)
  return group
}

const createPoiBeacons = (
  snapshot: DroneMapWorldSnapshot,
): THREE.Group => {
  const group = new THREE.Group()
  const beaconMaterial = new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#0ea5e9', emissiveIntensity: 0.7, roughness: 0.35 })
  const ringMaterial = new THREE.MeshBasicMaterial({ color: '#bae6fd', transparent: true, opacity: 0.54 })
  const points = snapshot.points.slice(0, 36)
  if (points.length === 0) return group
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.7, 18, 10), beaconMaterial, points.length)
  const rings = new THREE.InstancedMesh(new THREE.TorusGeometry(4, 0.08, 6, 28), ringMaterial, points.length)
  const dummy = new THREE.Object3D()
  for (const [index, point] of points.entries()) {
    dummy.position.set(point.point.x, 9, point.point.z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    stems.setMatrixAt(index, dummy.matrix)
    dummy.position.set(point.point.x, 18.2, point.point.z)
    dummy.rotation.set(Math.PI / 2, 0, 0)
    dummy.updateMatrix()
    rings.setMatrixAt(index, dummy.matrix)
  }
  stems.instanceMatrix.needsUpdate = true
  rings.instanceMatrix.needsUpdate = true
  group.add(stems, rings)
  return group
}

const createDistantHills = (
  radiusM: number,
): THREE.Mesh => {
  const inner = radiusM * 1.08
  const outer = radiusM * 1.75
  const segments = 64
  const positions: number[] = []
  const indices: number[] = []
  for (let index = 0; index <= segments; index += 1) {
    const angle = index / segments * Math.PI * 2
    const height = 90 + Math.sin(index * 0.47) * 26 + Math.sin(index * 0.13 + 2.1) * 42
    positions.push(Math.cos(angle) * inner, 0, Math.sin(angle) * inner)
    positions.push(Math.cos(angle) * outer, height, Math.sin(angle) * outer)
  }
  for (let index = 0; index < segments; index += 1) {
    const base = index * 2
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, makeMaterial('#64748b', 0.96, 0.01))
  mesh.receiveShadow = true
  return mesh
}

const createAtmosphereDome = (
  radiusM: number,
): THREE.Mesh => {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color('#6bb7f0') },
      bottomColor: { value: new THREE.Color('#dbeafe') },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.1, 0.95, h)), 1.0);
      }
    `,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radiusM * 3.5, 24, 12), material)
  dome.frustumCulled = false
  return dome
}

export const createFallbackWorldGroup = (
  radiusM = 1_600,
): THREE.Group => {
  const group = new THREE.Group()
  group.add(createAtmosphereDome(radiusM), createBaseGround(radiusM), createDistantHills(radiusM))
  return group
}

export const createDroneMapWorldGroup = (
  snapshot: DroneMapWorldSnapshot,
): THREE.Group => {
  const group = createFallbackWorldGroup(snapshot.radiusM)
  const surfaceGroup = createMergedSurfaceMeshes(snapshot.polygons)
  const buildingGroup = createMergedBuildingMeshes(snapshot.polygons)
  const transportGroup = createTransportGeometryGroup(snapshot)
  group.add(
    surfaceGroup,
    transportGroup,
    buildingGroup,
    createVegetation(snapshot),
    createPoiBeacons(snapshot),
  )
  group.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
      child.receiveShadow = child.userData.receiveShadow === false ? false : true
    }
    child.matrixAutoUpdate = false
    child.updateMatrix()
  })
  group.userData.worldSummary = {
    key: snapshot.key,
    tileCount: snapshot.tileCount,
    polygonCount: snapshot.polygons.length,
    lineCount: snapshot.lines.length,
    pointCount: snapshot.points.length,
  }
  return group
}

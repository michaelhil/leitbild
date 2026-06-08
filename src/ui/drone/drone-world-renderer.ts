import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldPoint,
  DroneWorldPolygonFeature,
} from './drone-map-world.ts'
import { createTransportGeometryGroup } from './drone-transport-renderer.ts'
import { terrainHeightAt, type DroneTerrainModel } from './drone-terrain.ts'

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const maxCachedRenderableWorlds = 4

const cachedRenderableWorlds = new Map<string, THREE.Group>()

const makeMaterial = (
  color: string,
  roughness = 0.72,
  metalness = 0.04,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })

const terrainY = (
  terrain: DroneTerrainModel | undefined,
  x: number,
  z: number,
  baseY: number,
): number =>
  baseY + (terrain ? terrainHeightAt(terrain, x, z) : 0)

const colorFromHex = (
  color: string,
): THREE.Color =>
  new THREE.Color(color)

const surfacePalette = (
  feature: DroneWorldPolygonFeature,
): string => {
  if (feature.kind === 'water') return '#1d8fb8'
  if (feature.className === 'wood' || feature.className === 'forest') return '#1f6f3a'
  if (feature.className === 'grass' || feature.className === 'park') return '#5d9b45'
  if (feature.className === 'wetland') return '#4f8a7a'
  if (feature.className === 'sand') return '#d7c88f'
  if (feature.className === 'farmland' || feature.className === 'farm') return '#9da85d'
  if (feature.className === 'scrub' || feature.className === 'heath') return '#6f8f57'
  if (feature.className === 'rock' || feature.className === 'bare_rock') return '#8d9292'
  if (feature.className === 'cemetery') return '#607f5f'
  if (feature.className === 'pitch' || feature.className === 'playground') return '#6aa96a'
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

const createGroundTexture = (): THREE.Texture | null => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = context.createImageData(canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = index / 4
    const x = pixel % canvas.width
    const y = Math.floor(pixel / canvas.width)
    const broad = Math.sin(x * 0.048 + y * 0.021) * 0.5 + Math.sin(x * 0.013 - y * 0.039) * 0.5
    const fineNoise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const grain = (fineNoise - Math.floor(fineNoise)) * 24
    const green = 94 + broad * 18 + grain
    image.data[index] = Math.round(74 + broad * 10 + grain * 0.45)
    image.data[index + 1] = Math.round(green)
    image.data[index + 2] = Math.round(75 + broad * 8 + grain * 0.38)
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
  terrain?: DroneTerrainModel,
): THREE.Mesh => {
  const texture = createGroundTexture()
  const material = new THREE.MeshStandardMaterial({
    color: '#617458',
    roughness: 0.95,
    metalness: 0.01,
    ...(texture === null ? {} : { map: texture }),
  })
  if (terrain?.kind === 'dem') {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let row = 0; row < terrain.gridSize; row += 1) {
      const z = -terrain.radiusM + row * terrain.sampleSpacingM
      for (let column = 0; column < terrain.gridSize; column += 1) {
        const x = -terrain.radiusM + column * terrain.sampleSpacingM
        positions.push(x, terrainHeightAt(terrain, x, z) - 0.42, z)
        uvs.push(column / (terrain.gridSize - 1) * 18, row / (terrain.gridSize - 1) * 18)
      }
    }
    for (let row = 0; row < terrain.gridSize - 1; row += 1) {
      for (let column = 0; column < terrain.gridSize - 1; column += 1) {
        const base = row * terrain.gridSize + column
        indices.push(base, base + terrain.gridSize, base + 1, base + 1, base + terrain.gridSize, base + terrain.gridSize + 1)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const ground = new THREE.Mesh(geometry, material)
    ground.receiveShadow = true
    return ground
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radiusM * 2.6, radiusM * 2.6, 1, 1), material)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.35
  ground.receiveShadow = true
  return ground
}

const surfaceYOffset = (
  feature: DroneWorldPolygonFeature,
): number => {
  const jitter = (stableHash(`${feature.kind}:${feature.className}`) % 7) * 0.0015
  if (feature.kind === 'water') return 0.16
  if (feature.kind === 'landuse') return 0.085 + jitter
  if (feature.kind === 'landcover') return 0.035 + jitter
  return 0.07 + jitter
}

const configureSurfaceDepth = (
  material: THREE.Material,
  feature: DroneWorldPolygonFeature,
): void => {
  material.polygonOffset = true
  material.polygonOffsetFactor = -2
  material.polygonOffsetUnits = feature.kind === 'water'
    ? -18
    : feature.kind === 'landuse'
      ? -12
      : -7
}

const createWaterMaterial = (): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    uniforms: {
      timeSeconds: { value: 0 },
      deepColor: { value: colorFromHex('#0d5f83') },
      shallowColor: { value: colorFromHex('#54c4d8') },
      foamColor: { value: colorFromHex('#d9fbff') },
      opacity: { value: 1 },
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
      uniform float timeSeconds;
      uniform vec3 deepColor;
      uniform vec3 shallowColor;
      uniform vec3 foamColor;
      uniform float opacity;
      varying vec3 vWorldPosition;

      float wave(vec2 p, float scale, float speed) {
        return sin(p.x * scale + p.y * scale * 0.37 + timeSeconds * speed)
          * sin(p.y * scale * 0.71 - timeSeconds * speed * 0.61);
      }

      void main() {
        vec2 p = vWorldPosition.xz;
        float ripples = wave(p, 0.034, 0.9) * 0.5 + wave(p, 0.095, 1.7) * 0.28 + wave(p, 0.19, 2.3) * 0.12;
        float sheen = smoothstep(0.55, 0.94, ripples);
        vec3 color = mix(deepColor, shallowColor, 0.44 + ripples * 0.18);
        color = mix(color, foamColor, sheen * 0.38);
        gl_FragColor = vec4(color, opacity);
      }
    `,
  })

const createBuildingWallMaterial = (
  color: string,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.84,
    metalness: 0.02,
  })

interface GeometryBucket {
  readonly material: THREE.Material
  readonly positions: number[]
  readonly uvs: number[]
  readonly indices: number[]
  readonly receiveShadow: boolean
  readonly castShadow: boolean
  readonly needsNormals: boolean
}

const getBucket = (
  buckets: Map<string, GeometryBucket>,
  key: string,
  material: THREE.Material,
  config: { readonly receiveShadow: boolean; readonly castShadow: boolean; readonly needsNormals: boolean },
): GeometryBucket => {
  const existing = buckets.get(key)
  if (existing) {
    material.dispose()
    return existing
  }
  const bucket = {
    material,
    positions: [],
    uvs: [],
    indices: [],
    receiveShadow: config.receiveShadow,
    castShadow: config.castShadow,
    needsNormals: config.needsNormals,
  }
  buckets.set(key, bucket)
  return bucket
}

const openRing = (
  ring: ReadonlyArray<DroneWorldPoint>,
): ReadonlyArray<DroneWorldPoint> => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (!first || !last || ring.length < 2) return ring
  return Math.hypot(first.x - last.x, first.z - last.z) < 0.001 ? ring.slice(0, -1) : ring
}

const appendHorizontalPolygon = (
  bucket: GeometryBucket,
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
  y: number,
  terrain: DroneTerrainModel | undefined,
): void => {
  const normalizedRings = rings.map(openRing).filter(ring => ring.length >= 3)
  const outer = normalizedRings[0]
  if (!outer) return
  const holes = normalizedRings.slice(1)
  const contour = outer.map(point => new THREE.Vector2(point.x, -point.z))
  const holeContours = holes.map(ring => ring.map(point => new THREE.Vector2(point.x, -point.z)))
  const triangles = THREE.ShapeUtils.triangulateShape(contour, holeContours)
  if (triangles.length === 0) return
  const vertices = [...outer, ...holes.flatMap(ring => ring)]
  const base = bucket.positions.length / 3
  for (const point of vertices) {
    bucket.positions.push(point.x, terrainY(terrain, point.x, point.z, y), point.z)
    bucket.uvs.push(point.x * 0.018, point.z * 0.018)
  }
  for (const triangle of triangles) {
    const a = triangle[0]
    const b = triangle[1]
    const c = triangle[2]
    if (a === undefined || b === undefined || c === undefined) continue
    bucket.indices.push(base + a, base + b, base + c)
  }
}

const appendBuildingWalls = (
  bucket: GeometryBucket,
  rings: ReadonlyArray<ReadonlyArray<DroneWorldPoint>>,
  minHeight: number,
  height: number,
  terrain: DroneTerrainModel | undefined,
): void => {
  for (const sourceRing of rings) {
    const ring = openRing(sourceRing)
    if (ring.length < 2) continue
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index]!
      const end = ring[(index + 1) % ring.length]!
      const length = Math.hypot(end.x - start.x, end.z - start.z)
      if (length < 0.1) continue
      const base = bucket.positions.length / 3
      const startBaseY = terrainY(terrain, start.x, start.z, minHeight)
      const endBaseY = terrainY(terrain, end.x, end.z, minHeight)
      bucket.positions.push(
        start.x, startBaseY, start.z,
        end.x, endBaseY, end.z,
        end.x, endBaseY + height, end.z,
        start.x, startBaseY + height, start.z,
      )
      bucket.uvs.push(0, 0, length * 0.12, 0, length * 0.12, height * 0.18, 0, height * 0.18)
      bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
}

const geometryFromBucket = (
  bucket: GeometryBucket,
): THREE.BufferGeometry | null => {
  if (bucket.positions.length === 0 || bucket.indices.length === 0) return null
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2))
  merged.setIndex(bucket.indices)
  if (bucket.needsNormals) merged.computeVertexNormals()
  merged.computeBoundingSphere()
  return merged
}

const meshesFromBuckets = (
  buckets: ReadonlyMap<string, GeometryBucket>,
): THREE.Group => {
  const group = new THREE.Group()
  for (const bucket of buckets.values()) {
    const geometry = geometryFromBucket(bucket)
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, bucket.material)
    mesh.receiveShadow = bucket.receiveShadow
    mesh.castShadow = bucket.castShadow
    mesh.userData.receiveShadow = bucket.receiveShadow
    mesh.userData.castShadow = bucket.castShadow
    group.add(mesh)
  }
  return group
}

const createMergedSurfaceMeshes = (
  polygons: ReadonlyArray<DroneWorldPolygonFeature>,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const buckets = new Map<string, GeometryBucket>()
  for (const feature of polygons) {
    if (feature.kind === 'building') continue
    const color = surfacePalette(feature)
    const isWater = feature.kind === 'water'
    const material = isWater
      ? createWaterMaterial()
      : new THREE.MeshBasicMaterial({
          color,
        })
    if (isWater) material.userData.droneWaterMaterial = true
    configureSurfaceDepth(material, feature)
    const bucket = getBucket(
      buckets,
      isWater ? 'water:shader' : `${feature.kind}:${feature.className}:${color}`,
      material,
      { receiveShadow: false, castShadow: false, needsNormals: false },
    )
    appendHorizontalPolygon(bucket, feature.rings, surfaceYOffset(feature), terrain)
  }
  return meshesFromBuckets(buckets)
}

const createMergedBuildingMeshes = (
  polygons: ReadonlyArray<DroneWorldPolygonFeature>,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const buckets = new Map<string, GeometryBucket>()
  for (const feature of polygons) {
    if (feature.kind !== 'building') continue
    const height = feature.heightM ?? 8
    if (height < 1) continue
    const minHeight = feature.minHeightM ?? 0
    const wallColor = feature.className === 'industrial'
      ? '#a8a29e'
      : feature.className === 'commercial'
        ? '#b8b4a7'
        : feature.className === 'apartments'
        ? '#bbb7ad'
        : '#c7c2b8'
    const wallBucket = getBucket(
      buckets,
      `building-wall:${feature.className}:${wallColor}`,
      createBuildingWallMaterial(wallColor),
      { receiveShadow: false, castShadow: false, needsNormals: true },
    )
    appendBuildingWalls(wallBucket, feature.rings, minHeight, height, terrain)

    const roofShade = clamp(0.72 + (stableHash(feature.id) % 24) / 100, 0.72, 0.94)
    const roofColor = new THREE.Color('#5d6672').multiplyScalar(roofShade).getStyle()
    const roofMaterial = new THREE.MeshBasicMaterial({ color: roofColor })
    roofMaterial.polygonOffset = true
    roofMaterial.polygonOffsetFactor = -2
    roofMaterial.polygonOffsetUnits = -16
    const roofBucket = getBucket(
      buckets,
      `building-roof:${Math.round(roofShade * 10)}`,
      roofMaterial,
      { receiveShadow: false, castShadow: false, needsNormals: false },
    )
    appendHorizontalPolygon(roofBucket, feature.rings, minHeight + height + 0.32, terrain)
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

const polygonCentroid = (
  ring: ReadonlyArray<DroneWorldPoint>,
): DroneWorldPoint => {
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

const createRooftopFixtures = (
  snapshot: DroneMapWorldSnapshot,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const buildings = snapshot.polygons
    .filter(feature => feature.kind === 'building' && feature.distanceM < Math.min(2_200, snapshot.radiusM * 0.55) && feature.areaM2 > 80)
    .slice(0, 900)
  const fixtures: Array<{
    readonly x: number
    readonly y: number
    readonly z: number
    readonly sx: number
    readonly sy: number
    readonly sz: number
    readonly rotation: number
  }> = []
  for (const building of buildings) {
    const outer = building.rings[0]
    if (!outer) continue
    const random = seededRandom(stableHash(`roof:${building.id}`))
    const bounds = polygonBounds(outer)
    const target = building.areaM2 > 1_800 ? 3 : building.areaM2 > 650 ? 2 : 1
    let added = 0
    for (let attempt = 0; attempt < target * 10 && added < target; attempt += 1) {
      const candidate = attempt === 0
        ? polygonCentroid(outer)
        : {
            x: bounds.minX + random() * (bounds.maxX - bounds.minX),
            z: bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
          }
      if (!pointInRing(candidate, outer)) continue
      const height = building.minHeightM ?? 0
      fixtures.push({
        x: candidate.x,
        y: terrainY(terrain, candidate.x, candidate.z, height + (building.heightM ?? 8) + 0.52),
        z: candidate.z,
        sx: 1.2 + random() * 2.6,
        sy: 0.45 + random() * 0.9,
        sz: 1.0 + random() * 2.2,
        rotation: random() * Math.PI * 2,
      })
      added += 1
    }
  }
  const group = new THREE.Group()
  if (fixtures.length === 0) return group
  const hvac = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    makeMaterial('#aeb7bf', 0.72, 0.04),
    fixtures.length,
  )
  const vent = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.42, 0.52, 1.4, 10),
    makeMaterial('#6f7a84', 0.74, 0.04),
    fixtures.length,
  )
  const dummy = new THREE.Object3D()
  for (const [index, fixture] of fixtures.entries()) {
    dummy.position.set(fixture.x, fixture.y, fixture.z)
    dummy.rotation.set(0, fixture.rotation, 0)
    dummy.scale.set(fixture.sx, fixture.sy, fixture.sz)
    dummy.updateMatrix()
    hvac.setMatrixAt(index, dummy.matrix)
    dummy.position.set(fixture.x + Math.cos(fixture.rotation) * fixture.sx * 0.55, fixture.y + fixture.sy * 0.62, fixture.z + Math.sin(fixture.rotation) * fixture.sz * 0.55)
    dummy.scale.set(0.65, 0.65, 0.65)
    dummy.updateMatrix()
    vent.setMatrixAt(index, dummy.matrix)
  }
  hvac.instanceMatrix.needsUpdate = true
  vent.instanceMatrix.needsUpdate = true
  hvac.receiveShadow = false
  vent.receiveShadow = false
  hvac.castShadow = false
  vent.castShadow = false
  group.add(hvac, vent)
  return group
}

const vegetationFeatures = (
  snapshot: DroneMapWorldSnapshot,
): ReadonlyArray<DroneWorldPolygonFeature> =>
  snapshot.polygons.filter(feature =>
    (feature.kind === 'landcover' || feature.kind === 'landuse')
    && ['wood', 'forest', 'scrub', 'heath', 'grass', 'park', 'residential'].includes(feature.className))

const createVegetation = (
  snapshot: DroneMapWorldSnapshot,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const features = vegetationFeatures(snapshot)
  const group = new THREE.Group()
  const maxTrees = 1_450
  const positions: Array<{ readonly x: number; readonly z: number; readonly scale: number }> = []
  for (const feature of features) {
    const outer = feature.rings[0]
    if (!outer || outer.length < 3 || positions.length >= maxTrees) continue
    const bounds = polygonBounds(outer)
    const area = Math.abs(polygonArea(outer))
    const distanceFactor = feature.distanceM < 1_500 ? 1 : feature.distanceM < 3_000 ? 0.62 : 0.32
    const targetCount = clamp(Math.floor(area / (feature.className === 'residential' ? 11_000 : 4_800) * distanceFactor), 2, 80)
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
    new THREE.CylinderGeometry(0.5, 0.74, 5.1, 8),
    makeMaterial('#6f3d1d', 0.9, 0.01),
    positions.length,
  )
  const canopy = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(3.6, 0),
    makeMaterial('#1f7a3a', 0.9, 0.01),
    positions.length,
  )
  const canopyTop = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(2.7, 0),
    makeMaterial('#2f8f45', 0.9, 0.01),
    positions.length,
  )
  const dummy = new THREE.Object3D()
  for (const [index, position] of positions.entries()) {
    const baseY = terrainY(terrain, position.x, position.z, 0)
    dummy.position.set(position.x, baseY + 2.6 * position.scale, position.z)
    dummy.scale.set(position.scale, position.scale, position.scale)
    dummy.rotation.y = stableHash(`${position.x}:${position.z}`) / 0xffffffff * Math.PI * 2
    dummy.updateMatrix()
    trunk.setMatrixAt(index, dummy.matrix)
    dummy.position.set(position.x, baseY + 7.5 * position.scale, position.z)
    dummy.updateMatrix()
    canopy.setMatrixAt(index, dummy.matrix)
    dummy.position.set(position.x + 0.8 * position.scale, baseY + 10.2 * position.scale, position.z - 0.4 * position.scale)
    dummy.scale.set(position.scale * 0.88, position.scale * 0.82, position.scale * 0.88)
    dummy.updateMatrix()
    canopyTop.setMatrixAt(index, dummy.matrix)
  }
  trunk.receiveShadow = false
  trunk.castShadow = false
  canopy.castShadow = false
  canopy.receiveShadow = false
  canopyTop.castShadow = false
  canopyTop.receiveShadow = false
  group.add(trunk, canopy, canopyTop)
  return group
}

const createPoiBeacons = (
  snapshot: DroneMapWorldSnapshot,
  terrain: DroneTerrainModel | undefined,
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
    const baseY = terrainY(terrain, point.point.x, point.point.z, 0)
    dummy.position.set(point.point.x, baseY + 9, point.point.z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    stems.setMatrixAt(index, dummy.matrix)
    dummy.position.set(point.point.x, baseY + 18.2, point.point.z)
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
  mesh.receiveShadow = false
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

const renderableWorldKeyFor = (
  snapshot: DroneMapWorldSnapshot,
  terrain: DroneTerrainModel | undefined,
): string =>
  `${snapshot.key}:${snapshot.center.lon.toFixed(6)}:${snapshot.center.lat.toFixed(6)}:${terrain?.kind ?? 'flat'}:${terrain?.kind === 'dem' ? `${terrain.source.zoom}:${terrain.minHeightM.toFixed(1)}:${terrain.maxHeightM.toFixed(1)}` : 'none'}`

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

const disposeRenderableWorldTemplate = (
  group: THREE.Object3D,
): void => {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments)) return
    geometries.add(child.geometry)
    if (Array.isArray(child.material)) {
      for (const material of child.material) materials.add(material)
    } else {
      materials.add(child.material)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) disposeMaterial(material)
}

const markSharedWorldGeometries = (
  group: THREE.Object3D,
): void => {
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments)) return
    child.geometry.userData.droneSharedWorldGeometry = true
  })
}

const collectWaterMaterials = (
  group: THREE.Object3D,
): THREE.ShaderMaterial[] => {
  const waterMaterials: THREE.ShaderMaterial[] = []
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (material.userData.droneWaterMaterial === true && material instanceof THREE.ShaderMaterial) waterMaterials.push(material)
    }
  })
  return waterMaterials
}

const cloneMaterialForScene = (
  material: THREE.Material,
): THREE.Material => {
  const cloned = material.clone()
  cloned.userData = { ...material.userData }
  const sourceTextured = material as THREE.Material & {
    readonly map?: THREE.Texture | null
    readonly normalMap?: THREE.Texture | null
    readonly roughnessMap?: THREE.Texture | null
    readonly metalnessMap?: THREE.Texture | null
    readonly emissiveMap?: THREE.Texture | null
    readonly alphaMap?: THREE.Texture | null
  }
  const clonedTextured = cloned as THREE.Material & {
    map?: THREE.Texture | null
    normalMap?: THREE.Texture | null
    roughnessMap?: THREE.Texture | null
    metalnessMap?: THREE.Texture | null
    emissiveMap?: THREE.Texture | null
    alphaMap?: THREE.Texture | null
  }
  const cloneTexture = (texture: THREE.Texture | null | undefined): THREE.Texture | null => {
    if (!texture) return null
    const clonedTexture = texture.clone()
    clonedTexture.needsUpdate = true
    return clonedTexture
  }
  clonedTextured.map = cloneTexture(sourceTextured.map)
  clonedTextured.normalMap = cloneTexture(sourceTextured.normalMap)
  clonedTextured.roughnessMap = cloneTexture(sourceTextured.roughnessMap)
  clonedTextured.metalnessMap = cloneTexture(sourceTextured.metalnessMap)
  clonedTextured.emissiveMap = cloneTexture(sourceTextured.emissiveMap)
  clonedTextured.alphaMap = cloneTexture(sourceTextured.alphaMap)
  return cloned
}

const cloneRenderableWorld = (
  template: THREE.Group,
): THREE.Group => {
  const clone = template.clone(true)
  clone.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments)) return
    child.material = Array.isArray(child.material)
      ? child.material.map(material => cloneMaterialForScene(material))
      : cloneMaterialForScene(child.material)
    child.matrixAutoUpdate = false
  })
  clone.userData.droneWaterMaterials = collectWaterMaterials(clone)
  return clone
}

const rememberRenderableWorld = (
  key: string,
  template: THREE.Group,
): void => {
  cachedRenderableWorlds.set(key, template)
  while (cachedRenderableWorlds.size > maxCachedRenderableWorlds) {
    const oldestKey = cachedRenderableWorlds.keys().next().value
    if (typeof oldestKey !== 'string') break
    const evicted = cachedRenderableWorlds.get(oldestKey)
    cachedRenderableWorlds.delete(oldestKey)
    if (evicted) disposeRenderableWorldTemplate(evicted)
  }
}

export const createFallbackWorldGroup = (
  radiusM = 1_600,
  terrain?: DroneTerrainModel,
): THREE.Group => {
  const group = new THREE.Group()
  group.add(createAtmosphereDome(radiusM), createBaseGround(radiusM, terrain), createDistantHills(radiusM))
  return group
}

const buildDroneMapWorldTemplate = (
  snapshot: DroneMapWorldSnapshot,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const group = createFallbackWorldGroup(snapshot.radiusM, terrain)
  const surfaceGroup = createMergedSurfaceMeshes(snapshot.polygons, terrain)
  const buildingGroup = createMergedBuildingMeshes(snapshot.polygons, terrain)
  const transportGroup = createTransportGeometryGroup(snapshot, terrain)
  group.add(
    surfaceGroup,
    transportGroup,
    buildingGroup,
    createRooftopFixtures(snapshot, terrain),
    createVegetation(snapshot, terrain),
    createPoiBeacons(snapshot, terrain),
  )
  group.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
      if (typeof child.userData.receiveShadow === 'boolean') child.receiveShadow = child.userData.receiveShadow
      if (typeof child.userData.castShadow === 'boolean') child.castShadow = child.userData.castShadow
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
    terrain: terrain?.kind ?? 'flat',
  }
  return group
}

export const createDroneMapWorldGroup = (
  snapshot: DroneMapWorldSnapshot,
  terrain?: DroneTerrainModel,
): THREE.Group => {
  const key = renderableWorldKeyFor(snapshot, terrain)
  const cached = cachedRenderableWorlds.get(key)
  if (cached) {
    cachedRenderableWorlds.delete(key)
    cachedRenderableWorlds.set(key, cached)
    return cloneRenderableWorld(cached)
  }
  const template = buildDroneMapWorldTemplate(snapshot, terrain)
  markSharedWorldGeometries(template)
  rememberRenderableWorld(key, template)
  return cloneRenderableWorld(template)
}

export const tickDroneMapWorldGroup = (
  group: THREE.Object3D,
  _nowMs: number,
  _viewMode: '2d' | '3d' | 'fpv',
): void => {
  const timeSeconds = 0
  const waterMaterials = group.userData.droneWaterMaterials
  if (!Array.isArray(waterMaterials)) return
  for (const material of waterMaterials) {
    if (!(material instanceof THREE.ShaderMaterial)) continue
    const uniform = material.uniforms.timeSeconds
    if (uniform) uniform.value = timeSeconds
  }
}

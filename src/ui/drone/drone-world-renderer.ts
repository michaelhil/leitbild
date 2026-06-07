import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldLineFeature,
  DroneWorldPoint,
  DroneWorldPolygonFeature,
} from './drone-map-world.ts'

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

const roadPalette = (
  feature: DroneWorldLineFeature,
): string => {
  if (feature.kind === 'rail') return '#556070'
  if (feature.kind === 'waterway') return '#2aa7c7'
  if (feature.className === 'motorway') return '#db7c59'
  if (feature.className === 'trunk') return '#df9957'
  if (feature.className === 'primary') return '#d7b858'
  if (feature.className === 'secondary') return '#d9cf83'
  if (feature.className === 'tertiary') return '#ded69f'
  return '#ece8dc'
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radiusM * 2.6, radiusM * 2.6, 96, 96), material)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.05
  ground.receiveShadow = true
  return ground
}

const createSurfaceMesh = (
  feature: DroneWorldPolygonFeature,
): THREE.Mesh | null => {
  const shape = shapeFor(feature.rings)
  if (!shape) return null
  const geometry = new THREE.ShapeGeometry(shape, 16)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({
    color: surfacePalette(feature),
    roughness: feature.kind === 'water' ? 0.45 : 0.9,
    metalness: feature.kind === 'water' ? 0.08 : 0.01,
    transparent: feature.kind === 'water',
    opacity: feature.kind === 'water' ? 0.82 : 0.88,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = feature.kind === 'water' ? 0.035 : 0.01
  mesh.receiveShadow = true
  return mesh
}

const createBuildingMesh = (
  feature: DroneWorldPolygonFeature,
): THREE.Group | null => {
  const shape = shapeFor(feature.rings)
  const height = feature.heightM ?? 8
  if (!shape || height < 1) return null
  const minHeight = feature.minHeightM ?? 0
  const group = new THREE.Group()
  const wallMaterial = makeMaterial(
    feature.className === 'industrial' ? '#a8a29e' : feature.className === 'commercial' ? '#b8b4a7' : '#c9c4ba',
    0.76,
    0.03,
  )
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSize: 0.22,
    bevelThickness: 0.22,
    bevelSegments: 1,
  })
  geometry.rotateX(-Math.PI / 2)
  const building = new THREE.Mesh(geometry, wallMaterial)
  building.position.y = minHeight
  building.castShadow = true
  building.receiveShadow = true
  group.add(building)

  const roofGeometry = new THREE.ShapeGeometry(shape, 12)
  roofGeometry.rotateX(-Math.PI / 2)
  const roof = new THREE.Mesh(roofGeometry, makeMaterial('#6b7280', 0.84, 0.02))
  roof.position.y = minHeight + height + 0.08
  roof.receiveShadow = true
  group.add(roof)

  if (height > 9) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 42),
      new THREE.LineBasicMaterial({ color: '#475569', transparent: true, opacity: 0.22 }),
    )
    edges.position.y = minHeight + 0.02
    group.add(edges)
  }
  return group
}

const createRibbonGeometry = (
  path: ReadonlyArray<DroneWorldPoint>,
  widthM: number,
  y: number,
): THREE.BufferGeometry => {
  const positions: number[] = []
  const indices: number[] = []
  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index]!
    const end = path[index + 1]!
    const dx = end.x - start.x
    const dz = end.z - start.z
    const length = Math.hypot(dx, dz)
    if (length < 0.2) continue
    const nx = -dz / length * widthM / 2
    const nz = dx / length * widthM / 2
    const base = positions.length / 3
    positions.push(
      start.x + nx, y, start.z + nz,
      start.x - nx, y, start.z - nz,
      end.x + nx, y, end.z + nz,
      end.x - nx, y, end.z - nz,
    )
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

const createLineMesh = (
  feature: DroneWorldLineFeature,
): THREE.Mesh | null => {
  const geometry = createRibbonGeometry(feature.path, feature.widthM, feature.kind === 'waterway' ? 0.08 : 0.07)
  const position = geometry.getAttribute('position')
  if (!(position instanceof THREE.BufferAttribute) || position.count === 0) {
    geometry.dispose()
    return null
  }
  const material = new THREE.MeshStandardMaterial({
    color: roadPalette(feature),
    roughness: feature.kind === 'waterway' ? 0.5 : 0.82,
    metalness: feature.kind === 'waterway' ? 0.04 : 0.01,
    transparent: feature.kind === 'waterway',
    opacity: feature.kind === 'waterway' ? 0.78 : 1,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  return mesh
}

const createLaneMarkings = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
): THREE.Group => {
  const group = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({ color: '#f8fafc', transparent: true, opacity: 0.78 })
  let dashCount = 0
  for (const line of lines) {
    if (line.kind !== 'road' || line.widthM < 8) continue
    for (let index = 0; index < line.path.length - 1; index += 1) {
      const start = line.path[index]!
      const end = line.path[index + 1]!
      const dx = end.x - start.x
      const dz = end.z - start.z
      const segmentLength = Math.hypot(dx, dz)
      if (segmentLength < 24) continue
      const ux = dx / segmentLength
      const uz = dz / segmentLength
      const yaw = Math.atan2(ux, uz)
      for (let distance = 12; distance < segmentLength - 8 && dashCount < 420; distance += 36) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 9), material)
        dash.rotation.x = -Math.PI / 2
        dash.rotation.z = -yaw
        dash.position.set(start.x + ux * distance, 0.095, start.z + uz * distance)
        group.add(dash)
        dashCount += 1
      }
    }
  }
  return group
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
  trunk.castShadow = true
  trunk.receiveShadow = true
  canopy.castShadow = true
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
  for (const point of snapshot.points.slice(0, 36)) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 18, 12), beaconMaterial)
    stem.position.set(point.point.x, 9, point.point.z)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.08, 8, 40), ringMaterial)
    ring.position.set(point.point.x, 18.2, point.point.z)
    ring.rotation.x = Math.PI / 2
    group.add(stem, ring)
  }
  return group
}

const createDistantHills = (
  radiusM: number,
): THREE.Mesh => {
  const inner = radiusM * 1.08
  const outer = radiusM * 1.75
  const segments = 96
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
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radiusM * 3.5, 32, 16), material)
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
  const surfaceGroup = new THREE.Group()
  const buildingGroup = new THREE.Group()
  const roadGroup = new THREE.Group()
  for (const polygon of snapshot.polygons) {
    if (polygon.kind === 'building') {
      const building = createBuildingMesh(polygon)
      if (building) buildingGroup.add(building)
      continue
    }
    const surface = createSurfaceMesh(polygon)
    if (surface) surfaceGroup.add(surface)
  }
  for (const line of snapshot.lines) {
    const mesh = createLineMesh(line)
    if (mesh) roadGroup.add(mesh)
  }
  roadGroup.add(createLaneMarkings(snapshot.lines))
  group.add(surfaceGroup, roadGroup, buildingGroup, createVegetation(snapshot), createPoiBeacons(snapshot))
  group.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
      child.castShadow = child.castShadow || child.position.y > 0.2
      child.receiveShadow = true
    }
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

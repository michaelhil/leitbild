import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldLineFeature,
  DroneWorldPoint,
  DroneWorldPolygonFeature,
} from './drone-map-world.ts'

interface BuildingClip {
  readonly ring: ReadonlyArray<DroneWorldPoint>
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

interface GeometryBucket {
  readonly material: THREE.Material
  readonly geometries: THREE.BufferGeometry[]
  readonly receiveShadow: boolean
  readonly renderOrder: number
}

const roadPalette = (
  feature: DroneWorldLineFeature,
): string => {
  if (feature.kind === 'rail') return '#66717f'
  if (feature.kind === 'waterway') return '#2aa8c8'
  if (feature.className === 'motorway') return '#e58152'
  if (feature.className === 'trunk') return '#e4a15a'
  if (feature.className === 'primary') return '#d9b84f'
  if (feature.className === 'secondary') return '#d8cd83'
  if (feature.className === 'tertiary') return '#ddd4a4'
  return '#ece9df'
}

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const roadPriority = (
  className: string,
): number => {
  if (className === 'motorway') return 90
  if (className === 'trunk') return 80
  if (className === 'primary') return 70
  if (className === 'secondary') return 60
  if (className === 'tertiary') return 50
  if (className === 'minor') return 40
  return 30
}

const transportDrawOrder = (
  line: DroneWorldLineFeature,
): number => {
  if (line.kind === 'waterway') return 10
  if (line.kind === 'rail') return 20
  return 100 + roadPriority(line.className)
}

const transportLinesForDrawing = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
): ReadonlyArray<DroneWorldLineFeature> =>
  [...lines].sort((left, right) => {
    const orderDelta = transportDrawOrder(left) - transportDrawOrder(right)
    if (orderDelta !== 0) return orderDelta
    return left.id.localeCompare(right.id)
  })

const linesByStyle = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
): ReadonlyMap<string, ReadonlyArray<DroneWorldLineFeature>> => {
  const groups = new Map<string, DroneWorldLineFeature[]>()
  for (const line of lines) {
    const color = roadPalette(line)
    const key = `${line.kind}:${line.className}:${color}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(line)
      continue
    }
    groups.set(key, [line])
  }
  return groups
}

const makeRoadMaterial = (
  color: string,
  transparent = false,
  opacity = 1,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.88,
    metalness: 0.01,
    transparent,
    opacity,
    depthWrite: !transparent,
  })

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

const buildingClipsFrom = (
  polygons: ReadonlyArray<DroneWorldPolygonFeature>,
): ReadonlyArray<BuildingClip> =>
  polygons.flatMap(feature => {
    if (feature.kind !== 'building') return []
    const ring = feature.rings[0]
    if (!ring || ring.length < 3) return []
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
    return [{ ring, minX, maxX, minZ, maxZ }]
  })

const pointInsideBuilding = (
  point: DroneWorldPoint,
  clips: ReadonlyArray<BuildingClip>,
): boolean => {
  for (const clip of clips) {
    if (point.x < clip.minX || point.x > clip.maxX || point.z < clip.minZ || point.z > clip.maxZ) continue
    if (pointInRing(point, clip.ring)) return true
  }
  return false
}

const segmentVisible = (
  start: DroneWorldPoint,
  end: DroneWorldPoint,
  line: DroneWorldLineFeature,
  clips: ReadonlyArray<BuildingClip>,
): boolean => {
  if (line.kind !== 'road' || clips.length === 0) return true
  const midpoint = {
    x: (start.x + end.x) / 2,
    z: (start.z + end.z) / 2,
  }
  return !pointInsideBuilding(midpoint, clips)
}

const visibleRunsForLine = (
  line: DroneWorldLineFeature,
  clips: ReadonlyArray<BuildingClip>,
): ReadonlyArray<ReadonlyArray<DroneWorldPoint>> => {
  const runs: DroneWorldPoint[][] = []
  let current: DroneWorldPoint[] = []
  for (let index = 0; index < line.path.length - 1; index += 1) {
    const start = line.path[index]!
    const end = line.path[index + 1]!
    const segmentLength = Math.hypot(end.x - start.x, end.z - start.z)
    if (segmentLength < 0.2 || !segmentVisible(start, end, line, clips)) {
      if (current.length >= 2) runs.push(current)
      current = []
      continue
    }
    if (current.length === 0) current.push(start)
    current.push(end)
  }
  if (current.length >= 2) runs.push(current)
  return runs
}

const simplifiedPath = (
  path: ReadonlyArray<DroneWorldPoint>,
  minDistanceM: number,
): ReadonlyArray<DroneWorldPoint> => {
  const first = path[0]
  const last = path[path.length - 1]
  if (!first || !last || path.length <= 2) return path
  const simplified: DroneWorldPoint[] = [first]
  let previous = first
  for (const point of path.slice(1, -1)) {
    if (Math.hypot(point.x - previous.x, point.z - previous.z) < minDistanceM) continue
    simplified.push(point)
    previous = point
  }
  if (last !== simplified[simplified.length - 1]) simplified.push(last)
  return simplified
}

const addRibbonRun = (
  positions: number[],
  indices: number[],
  path: ReadonlyArray<DroneWorldPoint>,
  widthM: number,
  y: number,
): void => {
  const points = simplifiedPath(path, 0.45)
  if (points.length < 2) return
  const halfWidth = widthM / 2
  const vertexBase = positions.length / 3
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!
    const previous = points[index - 1]
    const next = points[index + 1]
    const from = previous ?? point
    const to = next ?? point
    const prevDx = point.x - from.x
    const prevDz = point.z - from.z
    const nextDx = to.x - point.x
    const nextDz = to.z - point.z
    const prevLength = Math.max(0.001, Math.hypot(prevDx, prevDz))
    const nextLength = Math.max(0.001, Math.hypot(nextDx, nextDz))
    const prevNx = -prevDz / prevLength
    const prevNz = prevDx / prevLength
    const nextNx = -nextDz / nextLength
    const nextNz = nextDx / nextLength
    const joinedNx = previous && next ? prevNx + nextNx : previous ? prevNx : nextNx
    const joinedNz = previous && next ? prevNz + nextNz : previous ? prevNz : nextNz
    const joinedLength = Math.max(0.001, Math.hypot(joinedNx, joinedNz))
    const unitNx = joinedNx / joinedLength
    const unitNz = joinedNz / joinedLength
    const referenceNx = next ? nextNx : prevNx
    const referenceNz = next ? nextNz : prevNz
    const denom = Math.max(0.24, Math.abs(unitNx * referenceNx + unitNz * referenceNz))
    const miter = previous && next ? Math.min(halfWidth * 2.4, halfWidth / denom) : halfWidth
    const capExtension = halfWidth * 0.55
    const centerX = !previous && next
      ? point.x - nextDx / nextLength * capExtension
      : previous && !next
        ? point.x + prevDx / prevLength * capExtension
        : point.x
    const centerZ = !previous && next
      ? point.z - nextDz / nextLength * capExtension
      : previous && !next
        ? point.z + prevDz / prevLength * capExtension
        : point.z
    positions.push(
      centerX + unitNx * miter, y, centerZ + unitNz * miter,
      centerX - unitNx * miter, y, centerZ - unitNz * miter,
    )
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const base = vertexBase + index * 2
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
  }
}

const createRibbonGeometry = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
  widthFor: (line: DroneWorldLineFeature) => number,
  y: number,
  clips: ReadonlyArray<BuildingClip>,
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  for (const line of lines) {
    for (const run of visibleRunsForLine(line, clips)) {
      addRibbonRun(positions, indices, run, widthFor(line), y)
    }
  }
  if (positions.length === 0 || indices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

const addDashQuad = (
  positions: number[],
  indices: number[],
  centerX: number,
  centerZ: number,
  ux: number,
  uz: number,
  halfLength: number,
  halfWidth: number,
  y: number,
): void => {
  const nx = -uz
  const nz = ux
  const base = positions.length / 3
  positions.push(
    centerX + ux * halfLength + nx * halfWidth, y, centerZ + uz * halfLength + nz * halfWidth,
    centerX + ux * halfLength - nx * halfWidth, y, centerZ + uz * halfLength - nz * halfWidth,
    centerX - ux * halfLength + nx * halfWidth, y, centerZ - uz * halfLength + nz * halfWidth,
    centerX - ux * halfLength - nx * halfWidth, y, centerZ - uz * halfLength - nz * halfWidth,
  )
  indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
}

const createRoadMarkingGeometry = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
  clips: ReadonlyArray<BuildingClip>,
  config: { readonly y: number; readonly halfWidthM: number; readonly halfLengthM: number },
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  let dashCount = 0
  for (const line of lines) {
    if (line.kind !== 'road' || line.widthM < 8) continue
    const dashOffset = 6 + (stableHash(line.id) % 13)
    for (const run of visibleRunsForLine(line, clips)) {
      for (let index = 0; index < run.length - 1; index += 1) {
        const start = run[index]!
        const end = run[index + 1]!
        const dx = end.x - start.x
        const dz = end.z - start.z
        const length = Math.hypot(dx, dz)
        if (length < 20) continue
        const ux = dx / length
        const uz = dz / length
        for (let distance = dashOffset; distance < length - config.halfLengthM && dashCount < 2_200; distance += 31) {
          addDashQuad(
            positions,
            indices,
            start.x + ux * distance,
            start.z + uz * distance,
            ux,
            uz,
            config.halfLengthM,
            config.halfWidthM,
            config.y,
          )
          dashCount += 1
        }
      }
    }
  }
  if (positions.length === 0 || indices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

const addBucketGeometry = (
  buckets: Map<string, GeometryBucket>,
  key: string,
  material: THREE.Material,
  geometry: THREE.BufferGeometry | null,
  config: { readonly receiveShadow: boolean; readonly renderOrder: number },
): void => {
  if (!geometry) {
    material.dispose()
    return
  }
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
    renderOrder: config.renderOrder,
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
    mesh.userData.receiveShadow = bucket.receiveShadow
    mesh.renderOrder = bucket.renderOrder
    group.add(mesh)
  }
  return group
}

export const createTransportGeometryGroup = (
  snapshot: DroneMapWorldSnapshot,
): THREE.Group => {
  const group = new THREE.Group()
  const clips = buildingClipsFrom(snapshot.polygons)
  const lines = transportLinesForDrawing(snapshot.lines)
  const buckets = new Map<string, GeometryBucket>()

  const waterways = lines.filter(line => line.kind === 'waterway')
  addBucketGeometry(
    buckets,
    'waterway-casing',
    makeRoadMaterial('#075985', true, 0.5),
    createRibbonGeometry(waterways, line => line.widthM + 4, 0.075, []),
    { receiveShadow: false, renderOrder: 1 },
  )
  addBucketGeometry(
    buckets,
    'waterway-fill',
    makeRoadMaterial(roadPalette({ id: 'waterway', kind: 'waterway', className: 'river', path: [], widthM: 5 }), true, 0.82),
    createRibbonGeometry(waterways, line => line.widthM, 0.095, []),
    { receiveShadow: false, renderOrder: 2 },
  )

  const rails = lines.filter(line => line.kind === 'rail')
  addBucketGeometry(
    buckets,
    'rail-casing',
    makeRoadMaterial('#1f2937'),
    createRibbonGeometry(rails, line => line.widthM + 3.5, 0.105, []),
    { receiveShadow: true, renderOrder: 3 },
  )
  addBucketGeometry(
    buckets,
    'rail-fill',
    makeRoadMaterial('#94a3b8'),
    createRibbonGeometry(rails, line => line.widthM, 0.13, []),
    { receiveShadow: true, renderOrder: 4 },
  )

  const roads = lines.filter(line => line.kind === 'road')
  addBucketGeometry(
    buckets,
    'road-casing',
    makeRoadMaterial('#475569'),
    createRibbonGeometry(roads, line => line.widthM + Math.max(3.5, line.widthM * 0.18), 0.11, clips),
    { receiveShadow: true, renderOrder: 5 },
  )
  for (const [key, styledRoads] of linesByStyle(roads)) {
    const line = styledRoads[0]
    if (!line) continue
    const color = roadPalette(line)
    addBucketGeometry(
      buckets,
      `road-fill:${key}`,
      makeRoadMaterial(color),
      createRibbonGeometry(styledRoads, item => item.widthM, 0.135, clips),
      { receiveShadow: true, renderOrder: 6 },
    )
  }

  addBucketGeometry(
    buckets,
    'road-marking-shadow',
    new THREE.MeshBasicMaterial({ color: '#0f172a', transparent: true, opacity: 0.32, depthWrite: false }),
    createRoadMarkingGeometry(roads, clips, { y: 0.162, halfWidthM: 0.46, halfLengthM: 5.2 }),
    { receiveShadow: false, renderOrder: 8 },
  )
  addBucketGeometry(
    buckets,
    'road-marking-fill',
    new THREE.MeshBasicMaterial({ color: '#fff7ed', transparent: true, opacity: 0.96, depthWrite: false }),
    createRoadMarkingGeometry(roads, clips, { y: 0.174, halfWidthM: 0.22, halfLengthM: 4.7 }),
    { receiveShadow: false, renderOrder: 9 },
  )

  group.add(meshesFromBuckets(buckets))
  group.userData.receiveShadow = false
  return group
}

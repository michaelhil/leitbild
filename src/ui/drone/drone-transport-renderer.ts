import * as THREE from 'three'
import type {
  DroneMapWorldSnapshot,
  DroneWorldLineFeature,
  DroneWorldPoint,
} from './drone-map-world.ts'
import { terrainHeightAt, type DroneTerrainModel } from './drone-terrain.ts'

interface GeometryBucket {
  readonly material: THREE.Material
  readonly geometries: THREE.BufferGeometry[]
  readonly receiveShadow: boolean
  readonly renderOrder: number
}

const roadPalette = (
  feature: DroneWorldLineFeature,
): string => {
  if (feature.kind === 'aeroway') {
    if (feature.className === 'runway') return '#858071'
    if (feature.className === 'taxiway') return '#9a9383'
    return '#777268'
  }
  if (feature.kind === 'rail') return '#66717f'
  if (feature.kind === 'waterway') return '#2aa8c8'
  if (feature.className === 'motorway' || feature.className === 'motorway_link') return '#4b5563'
  if (feature.className === 'trunk' || feature.className === 'trunk_link') return '#505a66'
  if (feature.className === 'primary') return '#59636e'
  if (feature.className === 'secondary') return '#646c73'
  if (feature.className === 'tertiary') return '#737a7d'
  if (feature.className === 'residential' || feature.className === 'unclassified' || feature.className === 'street') return '#7d827d'
  if (feature.className === 'service' || feature.className === 'living_street') return '#8d9188'
  if (feature.className === 'path' || feature.className === 'track' || feature.className === 'footway' || feature.className === 'cycleway') return '#b7aa89'
  return '#858985'
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
  if (className === 'motorway' || className === 'motorway_link') return 90
  if (className === 'trunk' || className === 'trunk_link') return 80
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
  if (line.kind === 'aeroway') return 30
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
): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color,
    transparent,
    opacity,
    depthWrite: !transparent,
  })

const terrainY = (
  terrain: DroneTerrainModel | undefined,
  x: number,
  z: number,
  baseY: number,
): number =>
  baseY + (terrain ? terrainHeightAt(terrain, x, z) : 0)

interface PathSample {
  readonly x: number
  readonly z: number
  readonly ux: number
  readonly uz: number
  readonly y: number
}

interface TransportSceneryConfig {
  readonly solidBlockedAt?: (point: DroneWorldPoint) => boolean
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
  terrain: DroneTerrainModel | undefined,
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
    const leftX = centerX + unitNx * miter
    const leftZ = centerZ + unitNz * miter
    const rightX = centerX - unitNx * miter
    const rightZ = centerZ - unitNz * miter
    positions.push(
      leftX, terrainY(terrain, leftX, leftZ, y), leftZ,
      rightX, terrainY(terrain, rightX, rightZ, y), rightZ,
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
  terrain: DroneTerrainModel | undefined,
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  for (const line of lines) {
    addRibbonRun(positions, indices, line.path, widthFor(line), y + line.verticalOffsetM, terrain)
  }
  if (positions.length === 0 || indices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
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
  terrain: DroneTerrainModel | undefined,
): void => {
  const nx = -uz
  const nz = ux
  const base = positions.length / 3
  const p0 = { x: centerX + ux * halfLength + nx * halfWidth, z: centerZ + uz * halfLength + nz * halfWidth }
  const p1 = { x: centerX + ux * halfLength - nx * halfWidth, z: centerZ + uz * halfLength - nz * halfWidth }
  const p2 = { x: centerX - ux * halfLength + nx * halfWidth, z: centerZ - uz * halfLength + nz * halfWidth }
  const p3 = { x: centerX - ux * halfLength - nx * halfWidth, z: centerZ - uz * halfLength - nz * halfWidth }
  positions.push(
    p0.x, terrainY(terrain, p0.x, p0.z, y), p0.z,
    p1.x, terrainY(terrain, p1.x, p1.z, y), p1.z,
    p2.x, terrainY(terrain, p2.x, p2.z, y), p2.z,
    p3.x, terrainY(terrain, p3.x, p3.z, y), p3.z,
  )
  indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
}

const addSegmentLineQuad = (
  positions: number[],
  indices: number[],
  start: DroneWorldPoint,
  end: DroneWorldPoint,
  lateralOffsetM: number,
  halfWidthM: number,
  y: number,
  terrain: DroneTerrainModel | undefined,
): void => {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 0.2) return
  const ux = dx / length
  const uz = dz / length
  const nx = -uz
  const nz = ux
  const sx = start.x + nx * lateralOffsetM
  const sz = start.z + nz * lateralOffsetM
  const ex = end.x + nx * lateralOffsetM
  const ez = end.z + nz * lateralOffsetM
  const base = positions.length / 3
  const p0 = { x: sx + nx * halfWidthM, z: sz + nz * halfWidthM }
  const p1 = { x: sx - nx * halfWidthM, z: sz - nz * halfWidthM }
  const p2 = { x: ex + nx * halfWidthM, z: ez + nz * halfWidthM }
  const p3 = { x: ex - nx * halfWidthM, z: ez - nz * halfWidthM }
  positions.push(
    p0.x, terrainY(terrain, p0.x, p0.z, y), p0.z,
    p1.x, terrainY(terrain, p1.x, p1.z, y), p1.z,
    p2.x, terrainY(terrain, p2.x, p2.z, y), p2.z,
    p3.x, terrainY(terrain, p3.x, p3.z, y), p3.z,
  )
  indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
}

const createRoadEdgeLineGeometry = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
  config: { readonly y: number; readonly halfWidthM: number },
  terrain: DroneTerrainModel | undefined,
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  let segmentCount = 0
  for (const line of lines) {
    if (line.kind !== 'road' || line.widthM < 10) continue
    const offset = Math.max(2.8, line.widthM * 0.5 - 1.35)
    for (let index = 0; index < line.path.length - 1 && segmentCount < 4_000; index += 1) {
      const start = line.path[index]!
      const end = line.path[index + 1]!
      if (Math.hypot(end.x - start.x, end.z - start.z) < 7) continue
      addSegmentLineQuad(positions, indices, start, end, offset, config.halfWidthM, config.y + line.verticalOffsetM, terrain)
      addSegmentLineQuad(positions, indices, start, end, -offset, config.halfWidthM, config.y + line.verticalOffsetM, terrain)
      segmentCount += 2
    }
  }
  if (positions.length === 0 || indices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

const createRoadMarkingGeometry = (
  lines: ReadonlyArray<DroneWorldLineFeature>,
  config: { readonly y: number; readonly halfWidthM: number; readonly halfLengthM: number },
  terrain: DroneTerrainModel | undefined,
): THREE.BufferGeometry | null => {
  const positions: number[] = []
  const indices: number[] = []
  let dashCount = 0
  for (const line of lines) {
    if (line.kind !== 'road' || line.widthM < 8) continue
    const dashOffset = 6 + (stableHash(line.id) % 13)
    for (let index = 0; index < line.path.length - 1; index += 1) {
      const start = line.path[index]!
      const end = line.path[index + 1]!
      const dx = end.x - start.x
      const dz = end.z - start.z
      const length = Math.hypot(dx, dz)
      if (length < 20) continue
      const ux = dx / length
      const uz = dz / length
      for (let distance = dashOffset; distance < length - config.halfLengthM && dashCount < 2_800; distance += 31) {
        addDashQuad(
          positions,
          indices,
          start.x + ux * distance,
          start.z + uz * distance,
          ux,
          uz,
          config.halfLengthM,
          config.halfWidthM,
          config.y + line.verticalOffsetM,
          terrain,
        )
        dashCount += 1
      }
    }
  }
  if (positions.length === 0 || indices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

const collectPathSamples = (config: {
  readonly line: DroneWorldLineFeature
  readonly spacingM: number
  readonly startOffsetM: number
  readonly lateralOffsetM: number
  readonly y: number
  readonly maxSamples: number
}): ReadonlyArray<PathSample> => {
  const samples: PathSample[] = []
  let travelled = 0
  let targetDistance = config.startOffsetM
  for (let index = 0; index < config.line.path.length - 1 && samples.length < config.maxSamples; index += 1) {
    const start = config.line.path[index]!
    const end = config.line.path[index + 1]!
    const dx = end.x - start.x
    const dz = end.z - start.z
    const length = Math.hypot(dx, dz)
    if (length < 0.2) {
      travelled += length
      continue
    }
    const ux = dx / length
    const uz = dz / length
    const nx = -uz
    const nz = ux
    while (targetDistance <= travelled + length && samples.length < config.maxSamples) {
      const t = (targetDistance - travelled) / length
      const centerX = start.x + dx * t
      const centerZ = start.z + dz * t
      samples.push({
        x: centerX + nx * config.lateralOffsetM,
        z: centerZ + nz * config.lateralOffsetM,
        ux,
        uz,
        y: config.y + config.line.verticalOffsetM,
      })
      targetDistance += config.spacingM
    }
    travelled += length
  }
  return samples
}

const createRoadFurnitureGroup = (
  roads: ReadonlyArray<DroneWorldLineFeature>,
  terrain: DroneTerrainModel | undefined,
  config: TransportSceneryConfig,
): THREE.Group => {
  const group = new THREE.Group()
  const streetLights: PathSample[] = []
  const barrierPanels: PathSample[] = []
  const blocked = (sample: PathSample): boolean =>
    config.solidBlockedAt?.({ x: sample.x, z: sample.z }) ?? false
  for (const road of roads) {
    if (road.isTunnel || road.lengthM < 35 || road.distanceM > 3_400) continue
    const priority = roadPriority(road.className)
    const sideOffset = Math.max(4.2, road.widthM * 0.5 + 2.4)
    const startOffset = 18 + stableHash(`furniture:${road.id}`) % 39
    if ((priority >= 40 || road.className === 'residential' || road.className === 'unclassified') && streetLights.length < 1_200) {
      const spacingM = priority >= 70 ? 82 : priority >= 50 ? 96 : 118
      for (const side of [-1, 1] as const) {
        streetLights.push(...collectPathSamples({
          line: road,
          spacingM,
          startOffsetM: startOffset + (side > 0 ? 0 : spacingM * 0.48),
          lateralOffsetM: side * sideOffset,
          y: 0.2,
          maxSamples: 1_200 - streetLights.length,
        }).filter(sample => !blocked(sample)))
      }
    }
    if ((road.isBridge || priority >= 70) && barrierPanels.length < 1_000) {
      for (const side of [-1, 1] as const) {
        barrierPanels.push(...collectPathSamples({
          line: road,
          spacingM: 10,
          startOffsetM: 4,
          lateralOffsetM: side * Math.max(3.4, road.widthM * 0.5 + 0.7),
          y: 0.74,
          maxSamples: 1_000 - barrierPanels.length,
        }).filter(sample => !blocked(sample)))
      }
    }
  }

  const dummy = new THREE.Object3D()
  if (streetLights.length > 0) {
    const pole = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.08, 0.12, 6.2, 8),
      makeRoadMaterial('#475569'),
      streetLights.length,
    )
    const lamp = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.42, 0.18, 1.0),
      new THREE.MeshBasicMaterial({ color: '#fde68a' }),
      streetLights.length,
    )
    for (const [index, sample] of streetLights.entries()) {
      const baseY = terrainY(terrain, sample.x, sample.z, sample.y)
      dummy.position.set(sample.x, baseY + 3.1, sample.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      pole.setMatrixAt(index, dummy.matrix)
      dummy.position.set(sample.x, baseY + 6.28, sample.z)
      dummy.rotation.set(0, Math.atan2(sample.ux, sample.uz), 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      lamp.setMatrixAt(index, dummy.matrix)
    }
    pole.instanceMatrix.needsUpdate = true
    lamp.instanceMatrix.needsUpdate = true
    pole.userData.droneSceneryKind = 'road-furniture'
    lamp.userData.droneSceneryKind = 'road-furniture'
    group.add(pole, lamp)
  }

  if (barrierPanels.length > 0) {
    const barrier = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.18, 0.48, 7.4),
      makeRoadMaterial('#cbd5e1'),
      barrierPanels.length,
    )
    for (const [index, sample] of barrierPanels.entries()) {
      const baseY = terrainY(terrain, sample.x, sample.z, sample.y)
      dummy.position.set(sample.x, baseY, sample.z)
      dummy.rotation.set(0, Math.atan2(sample.ux, sample.uz), 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      barrier.setMatrixAt(index, dummy.matrix)
    }
    barrier.instanceMatrix.needsUpdate = true
    barrier.userData.droneSceneryKind = 'road-furniture'
    group.add(barrier)
  }

  group.userData.droneSceneryKind = 'road-furniture'
  return group
}

const addBucketGeometry = (
  buckets: Map<string, GeometryBucket>,
  key: string,
  material: THREE.Material,
  geometry: THREE.BufferGeometry | null,
  config: {
    readonly receiveShadow: boolean
    readonly renderOrder: number
    readonly polygonOffsetFactor?: number
    readonly polygonOffsetUnits?: number
  },
): void => {
  if (!geometry) {
    material.dispose()
    return
  }
  material.polygonOffset = true
  material.polygonOffsetFactor = config.polygonOffsetFactor ?? -2
  material.polygonOffsetUnits = config.polygonOffsetUnits ?? -config.renderOrder * 6
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
  terrain?: DroneTerrainModel,
  config: TransportSceneryConfig = {},
): THREE.Group => {
  const group = new THREE.Group()
  const lines = transportLinesForDrawing(snapshot.lines)
  const buckets = new Map<string, GeometryBucket>()

  const waterways = lines.filter(line => line.kind === 'waterway')
  addBucketGeometry(
    buckets,
    'waterway-casing',
    makeRoadMaterial('#075985'),
    createRibbonGeometry(waterways, line => line.widthM + 4, 0.22, terrain),
    { receiveShadow: false, renderOrder: 1 },
  )
  addBucketGeometry(
    buckets,
    'waterway-fill',
    makeRoadMaterial('#1fa8d1'),
    createRibbonGeometry(waterways, line => line.widthM, 0.26, terrain),
    { receiveShadow: false, renderOrder: 2 },
  )

  const rails = lines.filter(line => line.kind === 'rail')
  addBucketGeometry(
    buckets,
    'rail-casing',
    makeRoadMaterial('#1f2937'),
    createRibbonGeometry(rails, line => line.widthM + 3.5, 0.29, terrain),
    { receiveShadow: true, renderOrder: 3 },
  )
  addBucketGeometry(
    buckets,
    'rail-fill',
    makeRoadMaterial('#94a3b8'),
    createRibbonGeometry(rails, line => line.widthM, 0.34, terrain),
    { receiveShadow: true, renderOrder: 4 },
  )

  const aeroways = lines.filter(line => line.kind === 'aeroway')
  addBucketGeometry(
    buckets,
    'aeroway-casing',
    makeRoadMaterial('#3f3a34'),
    createRibbonGeometry(aeroways, line => line.widthM + 4.5, 0.35, terrain),
    { receiveShadow: true, renderOrder: 4 },
  )
  addBucketGeometry(
    buckets,
    'aeroway-fill',
    makeRoadMaterial('#8e897b'),
    createRibbonGeometry(aeroways, line => line.widthM, 0.41, terrain),
    { receiveShadow: true, renderOrder: 5 },
  )

  const roads = lines.filter(line => line.kind === 'road')
  addBucketGeometry(
    buckets,
    'road-shoulder',
    makeRoadMaterial('#d7d0bf'),
    createRibbonGeometry(roads, line => line.widthM + Math.max(6.5, line.widthM * 0.28), 0.32, terrain),
    { receiveShadow: true, renderOrder: 5 },
  )
  addBucketGeometry(
    buckets,
    'road-casing',
    makeRoadMaterial('#29313a'),
    createRibbonGeometry(roads, line => line.widthM + Math.max(3.5, line.widthM * 0.16), 0.37, terrain),
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
      createRibbonGeometry(styledRoads, item => item.widthM, 0.43, terrain),
      { receiveShadow: true, renderOrder: 6 },
    )
  }

  addBucketGeometry(
    buckets,
    'road-marking-shadow',
    new THREE.MeshBasicMaterial({ color: '#0f172a', transparent: true, opacity: 0.32, depthWrite: false }),
    createRoadMarkingGeometry(roads, { y: 0.6, halfWidthM: 0.46, halfLengthM: 5.2 }, terrain),
    { receiveShadow: false, renderOrder: 8, polygonOffsetFactor: -8, polygonOffsetUnits: -420 },
  )
  addBucketGeometry(
    buckets,
    'road-edge-lines',
    new THREE.MeshBasicMaterial({ color: '#e7e5d2', transparent: true, opacity: 0.72, depthWrite: false }),
    createRoadEdgeLineGeometry(roads, { y: 0.68, halfWidthM: 0.16 }, terrain),
    { receiveShadow: false, renderOrder: 8, polygonOffsetFactor: -8, polygonOffsetUnits: -460 },
  )
  addBucketGeometry(
    buckets,
    'road-marking-fill',
    new THREE.MeshBasicMaterial({ color: '#fefce8', transparent: true, opacity: 0.96, depthWrite: false }),
    createRoadMarkingGeometry(roads, { y: 0.76, halfWidthM: 0.22, halfLengthM: 4.7 }, terrain),
    { receiveShadow: false, renderOrder: 9, polygonOffsetFactor: -10, polygonOffsetUnits: -520 },
  )

  group.add(meshesFromBuckets(buckets))
  group.add(createRoadFurnitureGroup(roads, terrain, config))
  group.userData.receiveShadow = false
  return group
}

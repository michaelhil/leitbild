import { classifyRings, VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { mapTilesetId, type SceneryFeatureKind, type SceneryRecipe } from './capabilities.ts'
import {
  emptySceneryTile,
  sceneryTileSchema,
  type SceneryLineFeature,
  type SceneryPoint,
  type SceneryPolygonFeature,
  type SceneryTile,
  type SceneryTileCoord,
} from './scenery.ts'

interface VectorTilePoint {
  readonly x: number
  readonly y: number
}

const clippingEpsilon = 0.001

const defaultLayers = [
  'landcover',
  'landuse',
  'water',
  'waterway',
  'transportation',
  'transportation_name',
  'building',
  'aeroway',
  'place',
  'poi',
] as const

const kindLayerMap: Readonly<Record<SceneryFeatureKind, string>> = {
  aeroway: 'aeroway',
  building: 'building',
  landcover: 'landcover',
  landuse: 'landuse',
  place: 'place',
  poi: 'poi',
  transportation: 'transportation',
  transportation_name: 'transportation_name',
  water: 'water',
  waterway: 'waterway',
}

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const stringProperty = (
  properties: Record<string, unknown>,
  key: string,
  defaultValue = '',
): string => {
  const value = properties[key]
  return typeof value === 'string' && value.length > 0 ? value : defaultValue
}

const optionalStringProperty = (
  properties: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = properties[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const numberProperty = (
  properties: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null => {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

const booleanLikeProperty = (
  properties: Record<string, unknown>,
  key: string,
): boolean => {
  const value = properties[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return typeof value === 'string' && ['yes', 'true', '1'].includes(value.toLowerCase())
}

const booleanPropertyValue = (
  properties: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean | undefined => {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
    if (typeof value === 'string' && value.length > 0) {
      const normalized = value.toLowerCase()
      if (['yes', 'true', '1'].includes(normalized)) return true
      if (['no', 'false', '0'].includes(normalized)) return false
    }
  }
  return undefined
}

const buildingHeightFor = (
  id: string,
  className: string,
  properties: Record<string, unknown>,
): number => {
  const explicit = numberProperty(properties, ['render_height', 'height'])
  if (explicit !== null) return Math.max(2.5, Math.min(180, explicit))
  const levels = numberProperty(properties, ['render_levels', 'building:levels', 'levels'])
  if (levels !== null) return Math.max(2.5, Math.min(180, levels * 3.2))
  const base = className === 'apartments' ? 18 : className === 'commercial' ? 13 : className === 'industrial' ? 10 : 8
  return base + stableHash(id) % (className === 'apartments' ? 28 : 14)
}

const lineWidthFor = (
  kind: 'aeroway' | 'road' | 'rail' | 'waterway',
  className: string,
): number => {
  if (kind === 'aeroway') return className === 'runway' ? 38 : 18
  if (kind === 'rail') return 7
  if (kind === 'waterway') return className === 'river' ? 18 : 7
  if (className === 'motorway' || className === 'trunk') return 20
  if (className === 'primary') return 16
  if (className === 'secondary' || className === 'tertiary') return 12
  if (className === 'service' || className === 'track') return 7
  if (className === 'path') return 3.5
  return 9
}

const lineVerticalOffsetM = (config: {
  readonly isBridge: boolean
  readonly isTunnel: boolean
  readonly layer?: number
}): number => {
  if (config.isTunnel) return -1.2
  const layerOffset = (config.layer ?? 0) * 1.2
  return config.isBridge ? Math.max(1.8, 2.6 + layerOffset) : Math.max(0, layerOffset)
}

const pointFromVectorTile = (point: VectorTilePoint): SceneryPoint => [point.x, point.y]

const pointsClose = (
  left: VectorTilePoint,
  right: VectorTilePoint,
): boolean => Math.abs(left.x - right.x) <= clippingEpsilon && Math.abs(left.y - right.y) <= clippingEpsilon

const openVectorTileRing = (
  ring: ReadonlyArray<VectorTilePoint>,
): ReadonlyArray<VectorTilePoint> => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (!first || !last || ring.length < 2) return ring
  return pointsClose(first, last) ? ring.slice(0, -1) : ring
}

const closeVectorTileRing = (
  ring: ReadonlyArray<VectorTilePoint>,
): ReadonlyArray<VectorTilePoint> => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (!first || !last || ring.length < 3) return []
  return pointsClose(first, last) ? ring : [...ring, first]
}

const lineOutCode = (
  point: VectorTilePoint,
  extent: number,
): number => {
  let code = 0
  if (point.x < 0) code |= 1
  if (point.x > extent) code |= 2
  if (point.y < 0) code |= 4
  if (point.y > extent) code |= 8
  return code
}

const clipLineSegmentToExtent = (
  start: VectorTilePoint,
  end: VectorTilePoint,
  extent: number,
): readonly [VectorTilePoint, VectorTilePoint] | null => {
  let x0 = start.x
  let y0 = start.y
  let x1 = end.x
  let y1 = end.y
  let code0 = lineOutCode({ x: x0, y: y0 }, extent)
  let code1 = lineOutCode({ x: x1, y: y1 }, extent)
  while (true) {
    if ((code0 | code1) === 0) return [{ x: x0, y: y0 }, { x: x1, y: y1 }]
    if ((code0 & code1) !== 0) return null
    const outsideCode = code0 !== 0 ? code0 : code1
    const dx = x1 - x0
    const dy = y1 - y0
    let x = 0
    let y = 0
    if ((outsideCode & 8) !== 0) {
      y = extent
      x = Math.abs(dy) <= clippingEpsilon ? x0 : x0 + dx * (extent - y0) / dy
    } else if ((outsideCode & 4) !== 0) {
      y = 0
      x = Math.abs(dy) <= clippingEpsilon ? x0 : x0 + dx * (0 - y0) / dy
    } else if ((outsideCode & 2) !== 0) {
      x = extent
      y = Math.abs(dx) <= clippingEpsilon ? y0 : y0 + dy * (extent - x0) / dx
    } else {
      x = 0
      y = Math.abs(dx) <= clippingEpsilon ? y0 : y0 + dy * (0 - x0) / dx
    }
    if (outsideCode === code0) {
      x0 = x
      y0 = y
      code0 = lineOutCode({ x: x0, y: y0 }, extent)
    } else {
      x1 = x
      y1 = y
      code1 = lineOutCode({ x: x1, y: y1 }, extent)
    }
  }
}

const appendClippedPoint = (
  points: VectorTilePoint[],
  point: VectorTilePoint,
): void => {
  const previous = points[points.length - 1]
  if (!previous || !pointsClose(previous, point)) points.push(point)
}

const clippedLinePartsToExtent = (
  line: ReadonlyArray<VectorTilePoint>,
  extent: number,
): ReadonlyArray<ReadonlyArray<VectorTilePoint>> => {
  const parts: VectorTilePoint[][] = []
  let current: VectorTilePoint[] = []
  for (let index = 0; index < line.length - 1; index += 1) {
    const clipped = clipLineSegmentToExtent(line[index]!, line[index + 1]!, extent)
    if (!clipped) {
      if (current.length >= 2) parts.push(current)
      current = []
      continue
    }
    const [segmentStart, segmentEnd] = clipped
    const previous = current[current.length - 1]
    if (previous && !pointsClose(previous, segmentStart)) {
      if (current.length >= 2) parts.push(current)
      current = []
    }
    appendClippedPoint(current, segmentStart)
    appendClippedPoint(current, segmentEnd)
  }
  if (current.length >= 2) parts.push(current)
  return parts
}

const clipRingAgainstEdge = (
  ring: ReadonlyArray<VectorTilePoint>,
  inside: (point: VectorTilePoint) => boolean,
  intersect: (start: VectorTilePoint, end: VectorTilePoint) => VectorTilePoint,
): ReadonlyArray<VectorTilePoint> => {
  if (ring.length === 0) return []
  const output: VectorTilePoint[] = []
  let previous = ring[ring.length - 1]!
  let previousInside = inside(previous)
  for (const current of ring) {
    const currentInside = inside(current)
    if (currentInside) {
      if (!previousInside) appendClippedPoint(output, intersect(previous, current))
      appendClippedPoint(output, current)
    } else if (previousInside) {
      appendClippedPoint(output, intersect(previous, current))
    }
    previous = current
    previousInside = currentInside
  }
  return output
}

const clipRingToExtent = (
  sourceRing: ReadonlyArray<VectorTilePoint>,
  extent: number,
): ReadonlyArray<VectorTilePoint> => {
  const ring = openVectorTileRing(sourceRing)
  if (ring.length < 3) return []
  const clippedLeft = clipRingAgainstEdge(
    ring,
    point => point.x >= 0,
    (start, end) => ({ x: 0, y: start.y + (end.y - start.y) * (0 - start.x) / (end.x - start.x) }),
  )
  const clippedRight = clipRingAgainstEdge(
    clippedLeft,
    point => point.x <= extent,
    (start, end) => ({ x: extent, y: start.y + (end.y - start.y) * (extent - start.x) / (end.x - start.x) }),
  )
  const clippedTop = clipRingAgainstEdge(
    clippedRight,
    point => point.y >= 0,
    (start, end) => ({ x: start.x + (end.x - start.x) * (0 - start.y) / (end.y - start.y), y: 0 }),
  )
  const clippedBottom = clipRingAgainstEdge(
    clippedTop,
    point => point.y <= extent,
    (start, end) => ({ x: start.x + (end.x - start.x) * (extent - start.y) / (end.y - start.y), y: extent }),
  )
  return closeVectorTileRing(clippedBottom)
}

const lineFromGeometry = (
  line: ReadonlyArray<VectorTilePoint>,
): SceneryPoint[] =>
  line.map(pointFromVectorTile)

const polygonRingsFromGeometry = (
  polygon: ReadonlyArray<ReadonlyArray<VectorTilePoint>>,
  extent: number,
): SceneryPoint[][] =>
  polygon
    .map(ring => clipRingToExtent(ring, extent))
    .map(lineFromGeometry)
    .filter(ring => ring.length >= 3)

const labelPointForPath = (
  path: ReadonlyArray<SceneryPoint>,
): SceneryPoint | null => {
  if (path.length === 0) return null
  if (path.length === 1) return path[0] ?? null
  return path[Math.floor(path.length / 2)] ?? null
}

const polygonFeaturesFor = (
  id: string,
  sourceLayer: string,
  kind: SceneryPolygonFeature['kind'],
  className: string,
  vectorFeature: VectorTileFeature,
  properties: Record<string, unknown>,
): ReadonlyArray<SceneryPolygonFeature> => {
  if (vectorFeature.type !== 3) return []
  return classifyRings(vectorFeature.loadGeometry()).flatMap((polygon, index) => {
    const rings = polygonRingsFromGeometry(polygon, vectorFeature.extent)
    if (rings.length === 0) return []
    const name = optionalStringProperty(properties, 'name')
    const subclass = optionalStringProperty(properties, 'subclass')
    const heightM = kind === 'building' ? buildingHeightFor(id, className, properties) : undefined
    const minHeightM = kind === 'building'
      ? numberProperty(properties, ['render_min_height', 'min_height']) ?? undefined
      : undefined
    return [{
      id: `${id}:${index}`,
      sourceLayer,
      ...(vectorFeature.id === undefined ? {} : { sourceRef: `${sourceLayer}:${vectorFeature.id}` }),
      kind,
      className,
      ...(name === undefined ? {} : { name }),
      ...(subclass === undefined ? {} : { subclass }),
      rings,
      ...(heightM === undefined ? {} : { heightM }),
      ...(minHeightM === undefined ? {} : { minHeightM }),
    }]
  })
}

const lineFeaturesFor = (
  id: string,
  sourceLayer: string,
  kind: SceneryLineFeature['kind'],
  className: string,
  vectorFeature: VectorTileFeature,
  properties: Record<string, unknown>,
): ReadonlyArray<SceneryLineFeature> => {
  if (vectorFeature.type !== 2) return []
  const brunnel = optionalStringProperty(properties, 'brunnel')
  const isBridge = brunnel === 'bridge' || booleanLikeProperty(properties, 'bridge')
  const isTunnel = brunnel === 'tunnel' || booleanLikeProperty(properties, 'tunnel')
  const layer = numberProperty(properties, ['layer']) ?? undefined
  const surface = optionalStringProperty(properties, 'surface')
  const name = optionalStringProperty(properties, 'name')
  const subclass = optionalStringProperty(properties, 'subclass')
  const service = optionalStringProperty(properties, 'service')
  const access = optionalStringProperty(properties, 'access')
  const maxspeedKph = numberProperty(properties, ['maxspeed']) ?? undefined
  const oneway = booleanPropertyValue(properties, ['oneway'])
  const verticalOffsetM = lineVerticalOffsetM({ isBridge, isTunnel, ...(layer === undefined ? {} : { layer }) })
  return vectorFeature.loadGeometry().flatMap((line, lineIndex) => {
    const clippedParts = clippedLinePartsToExtent(line, vectorFeature.extent)
    return clippedParts.flatMap((part, partIndex) => {
      const path = lineFromGeometry(part)
      if (path.length < 2) return []
      const segmentId = clippedParts.length === 1 ? `${id}:${lineIndex}` : `${id}:${lineIndex}:${partIndex}`
      return [{
        id: segmentId,
        sourceLayer,
        ...(vectorFeature.id === undefined ? {} : { sourceRef: `${sourceLayer}:${vectorFeature.id}` }),
        kind,
        className,
        ...(subclass === undefined ? {} : { subclass }),
        ...(name === undefined ? {} : { name }),
        ...(surface === undefined ? {} : { surface }),
        ...(brunnel === undefined ? {} : { brunnel }),
        ...(layer === undefined ? {} : { layer }),
        ...(service === undefined ? {} : { service }),
        ...(access === undefined ? {} : { access }),
        ...(maxspeedKph === undefined ? {} : { maxspeedKph }),
        ...(oneway === undefined ? {} : { oneway }),
        isBridge,
        isTunnel,
        path,
        widthM: lineWidthFor(kind, className),
        verticalOffsetM,
      }]
    })
  })
}

const labelFeaturesForLine = (
  id: string,
  sourceLayer: string,
  className: string,
  label: string,
  vectorFeature: VectorTileFeature,
): ReadonlyArray<SceneryTile['features']['labels'][number]> => {
  if (vectorFeature.type !== 2) return []
  return vectorFeature.loadGeometry().flatMap((line, index) => {
    const path = lineFromGeometry(line)
    const point = labelPointForPath(path)
    return point
      ? [{ id: `${id}:${index}`, sourceLayer, kind: 'road_label' as const, className, label, point }]
      : []
  })
}

const labelFeaturesForPoint = (
  id: string,
  sourceLayer: string,
  kind: 'place' | 'poi',
  className: string,
  label: string,
  vectorFeature: VectorTileFeature,
): ReadonlyArray<SceneryTile['features']['labels'][number]> => {
  if (vectorFeature.type !== 1) return []
  return vectorFeature.loadGeometry().flatMap((line, index) => {
    const point = line[0]
    return point
      ? [{ id: `${id}:${index}`, sourceLayer, kind, className, label, point: pointFromVectorTile(point) }]
      : []
  })
}

const compileLayer = (
  vectorTile: VectorTile,
  tileCoord: SceneryTileCoord,
  layerId: string,
): SceneryTile['features'] => {
  const layer = vectorTile.layers[layerId]
  if (!layer) return { polygons: [], lines: [], labels: [] }
  const polygons: SceneryPolygonFeature[] = []
  const lines: SceneryLineFeature[] = []
  const labels: SceneryTile['features']['labels'] = []
  for (let index = 0; index < layer.length; index += 1) {
    const vectorFeature = layer.feature(index)
    const properties = vectorFeature.properties as Record<string, unknown>
    const className = stringProperty(properties, 'class', stringProperty(properties, 'type', layerId))
    const id = `${tileCoord.z}/${tileCoord.x}/${tileCoord.y}:${layerId}:${vectorFeature.id ?? index}`
    if (layerId === 'building') {
      polygons.push(...polygonFeaturesFor(id, layerId, 'building', className, vectorFeature, properties))
    } else if (layerId === 'aeroway') {
      polygons.push(...polygonFeaturesFor(id, layerId, 'aeroway', className, vectorFeature, properties))
      lines.push(...lineFeaturesFor(id, layerId, 'aeroway', className, vectorFeature, properties))
    } else if (layerId === 'water') {
      polygons.push(...polygonFeaturesFor(id, layerId, 'water', className, vectorFeature, properties))
    } else if (layerId === 'landcover') {
      polygons.push(...polygonFeaturesFor(id, layerId, 'landcover', className, vectorFeature, properties))
    } else if (layerId === 'landuse') {
      polygons.push(...polygonFeaturesFor(id, layerId, 'landuse', className, vectorFeature, properties))
    } else if (layerId === 'waterway') {
      lines.push(...lineFeaturesFor(id, layerId, 'waterway', className, vectorFeature, properties))
    } else if (layerId === 'transportation') {
      const kind = className === 'rail' ? 'rail' : 'road'
      lines.push(...lineFeaturesFor(id, layerId, kind, className, vectorFeature, properties))
    } else if (layerId === 'transportation_name') {
      const label = optionalStringProperty(properties, 'name')
      if (label) labels.push(...labelFeaturesForLine(id, layerId, className, label, vectorFeature))
    } else if (layerId === 'poi') {
      const label = stringProperty(properties, 'name', className)
      labels.push(...labelFeaturesForPoint(id, layerId, 'poi', className, label, vectorFeature))
    } else if (layerId === 'place') {
      const label = stringProperty(properties, 'name', className)
      labels.push(...labelFeaturesForPoint(id, layerId, 'place', className, label, vectorFeature))
    }
  }
  return { polygons, lines, labels }
}

export const sourceLayersForSceneryRecipe = (
  recipe: SceneryRecipe,
): ReadonlyArray<string> => {
  const requested = new Set(recipe.featureKinds.map(kind => kindLayerMap[kind]))
  return defaultLayers.filter(layer => requested.has(layer))
}

export const compileSceneryTileFromVectorTile = (config: {
  readonly vectorTile: VectorTile
  readonly tile: SceneryTileCoord
  readonly recipe: SceneryRecipe
}): SceneryTile => {
  const features = sourceLayersForSceneryRecipe(config.recipe)
    .map(layer => compileLayer(config.vectorTile, config.tile, layer))
  return sceneryTileSchema.parse({
    ...emptySceneryTile({
      recipeId: config.recipe.id,
      sourceTilesetId: config.recipe.sourceTilesetId,
      tile: config.tile,
    }),
    features: {
      polygons: features.flatMap(feature => feature.polygons),
      lines: features.flatMap(feature => feature.lines),
      labels: features.flatMap(feature => feature.labels),
    },
  })
}

export const compileSceneryTileFromMvtBytes = (config: {
  readonly bytes: ArrayBuffer | Uint8Array
  readonly tile: SceneryTileCoord
  readonly recipe: SceneryRecipe
}): SceneryTile => {
  const bytes = config.bytes instanceof Uint8Array ? config.bytes : new Uint8Array(config.bytes)
  const pbf = new PbfReader(bytes) as unknown as ConstructorParameters<typeof VectorTile>[0]
  return compileSceneryTileFromVectorTile({
    vectorTile: new VectorTile(pbf),
    tile: config.tile,
    recipe: config.recipe,
  })
}

export const emptySceneryTileForRecipe = (config: {
  readonly tile: SceneryTileCoord
  readonly recipe: SceneryRecipe
}): SceneryTile =>
  emptySceneryTile({
    recipeId: config.recipe.id,
    sourceTilesetId: mapTilesetId,
    tile: config.tile,
  })

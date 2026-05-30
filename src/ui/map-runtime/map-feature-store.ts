import type { GeoJsonPoint, GeoJsonPolygon, OperationalObject } from '../../core/model/index.ts'
import { remainingRouteGeometry } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { colorWithAlpha, hexToRgba, toneColor, white } from './colors.ts'
import { normalizeSymbolId, symbolSizePx } from './symbol-kit.ts'
import {
  lineStringPositions,
  pointPosition,
  type MapFeatureProjectionContext,
  type OperationalAreaFeature,
  type OperationalPathFeature,
  type OperationalPointFeature,
  type OperationalRenderInput,
  type OperationalRenderSnapshot,
  type OperationalSymbolFeature,
  type Position2,
  type Position3,
} from './types.ts'

export interface MapFeatureStore {
  readonly update: (input: OperationalRenderInput) => OperationalRenderSnapshot
  readonly snapshot: () => OperationalRenderSnapshot
}

interface FamilyState<T extends { readonly id: string; readonly signature: string }> {
  readonly items: T[]
  readonly signatures: Map<string, string>
  revision: number
}

const createFamilyState = <T extends { readonly id: string; readonly signature: string }>(): FamilyState<T> => ({
  items: [],
  signatures: new Map(),
  revision: 0,
})

const idsMatch = <T extends { readonly id: string }>(
  left: ReadonlyArray<T>,
  right: ReadonlyArray<T>,
): boolean =>
  left.length === right.length && left.every((item, index) => item.id === right[index]?.id)

const syncFamily = <T extends { readonly id: string; readonly signature: string }>(
  family: FamilyState<T>,
  nextItems: ReadonlyArray<T>,
): void => {
  let changed = !idsMatch(family.items, nextItems)
  if (changed) {
    family.items.splice(0, family.items.length, ...nextItems)
    family.signatures.clear()
    for (const item of nextItems) family.signatures.set(item.id, item.signature)
    family.revision += 1
    return
  }
  for (let index = 0; index < nextItems.length; index += 1) {
    const next = nextItems[index]!
    if (family.signatures.get(next.id) === next.signature) continue
    family.items[index] = next
    family.signatures.set(next.id, next.signature)
    changed = true
  }
  if (changed) family.revision += 1
}

const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
  object.spatial.position?.point ?? null

const rounded = (value: number, digits = 5): string =>
  value.toFixed(digits)

const positionSignature = (position: Position3): string =>
  `${rounded(position[0])},${rounded(position[1])},${rounded(position[2])}`

const pathSignature = (path: ReadonlyArray<Position2>): string =>
  `${path.length}:${path.map(point => `${rounded(point[0])},${rounded(point[1])}`).join('|')}`

const polygonSignature = (polygon: GeoJsonPolygon): string =>
  polygon.coordinates
    .map(ring => ring.map(point => `${rounded(point[0])},${rounded(point[1])}`).join('|'))
    .join('::')

const pointPriority = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): number => {
  if (presentation.status?.tone === 'error') return 90
  if (object.operational.priority === 'critical') return 85
  if (presentation.status?.tone === 'working') return 70
  if (object.kind === 'mobile_entity') return 60
  return 40
}

const presentationTone = (presentation: PackObjectPresentation): NonNullable<PackObjectPresentation['status']>['tone'] =>
  presentation.status?.tone ?? 'idle'

const operationalPointFor = (
  object: OperationalObject,
  context: MapFeatureProjectionContext,
): OperationalPointFeature | null => {
  const point = pointOf(object)
  if (!point) return null
  const presentation = context.presentationFor(object)
  if (presentation.mapIconVisible === false) return null
  const tone = presentationTone(presentation)
  const symbolId = normalizeSymbolId(presentation.icon)
  const position = pointPosition(point)
  const selected = object.id === context.selectedControllerId
  const highlighted = context.highlightedObjectIds.has(object.id)
  const hasNewInfo = presentation.noteworthyUpdates === true && context.hasNewInfo(object)
  const muted = presentation.muted === true
  const color = muted ? colorWithAlpha(hexToRgba(presentation.color), 132) : hexToRgba(presentation.color)
  const signature = [
    object.id,
    positionSignature(position),
    symbolId,
    presentation.color,
    tone,
    selected ? 's' : '',
    highlighted ? 'h' : '',
    hasNewInfo ? 'n' : '',
    muted ? 'm' : '',
  ].join(':')
  return {
    id: object.id,
    object,
    position,
    symbolId,
    color,
    statusTone: tone,
    selected,
    highlighted,
    hasNewInfo,
    muted,
    sizePx: symbolSizePx(symbolId),
    rotationDeg: 0,
    priority: pointPriority(object, presentation),
    signature,
  }
}

const routePathFor = (
  object: OperationalObject,
  selectedObjectId: string | null,
): OperationalPathFeature | null => {
  const route = object.spatial.route?.planned
  if (object.kind !== 'mobile_entity' || !route) return null
  const point = pointOf(object)
  const geometry = point && object.spatial.route?.progress
    ? remainingRouteGeometry(route, point, object.spatial.route.progress.segmentIndex)
    : route
  if (!geometry) return null
  const path = lineStringPositions(geometry)
  const selected = object.id === selectedObjectId
  return {
    id: `route:${object.id}`,
    kind: 'route',
    path,
    color: selected ? hexToRgba('#1d66d2') : hexToRgba('#3977d6', 190),
    casingColor: white(184),
    widthPx: selected ? 3.8 : 2.8,
    selected,
    priority: selected ? 80 : 45,
    signature: `route:${object.id}:${selected ? '1' : '0'}:${pathSignature(path)}`,
  }
}

const lineObjectPathFor = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): OperationalPathFeature | null => {
  if (object.spatial.geometry?.type !== 'LineString') return null
  const category = presentation.categoryId
  if (category !== 'traffic' && category !== 'weather') return null
  const kind = category === 'traffic' ? 'traffic' : 'weather-line'
  const path = lineStringPositions(object.spatial.geometry)
  const tone = presentationTone(presentation)
  const widthPx = category === 'traffic' ? 4.0 : 2.5
  return {
    id: `${kind}:${object.id}`,
    kind,
    path,
    color: colorWithAlpha(hexToRgba(presentation.color), 214),
    casingColor: white(150),
    widthPx,
    selected: false,
    priority: tone === 'error' ? 85 : tone === 'working' ? 70 : 35,
    signature: `${kind}:${object.id}:${presentation.color}:${tone}:${pathSignature(path)}`,
  }
}

const trafficAreaFor = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): OperationalAreaFeature | null => {
  if (object.spatial.geometry?.type !== 'Polygon' || presentation.categoryId !== 'traffic') return null
  const polygon = object.spatial.geometry
  return {
    id: `traffic-area:${object.id}`,
    kind: 'traffic',
    polygon,
    color: colorWithAlpha(hexToRgba(presentation.color), 58),
    lineColor: colorWithAlpha(hexToRgba(presentation.color), 210),
    opacity: 0.22,
    lineWidthPx: 2,
    sortKey: 20,
    signature: `traffic-area:${object.id}:${presentation.color}:${polygonSignature(polygon)}`,
  }
}

const areaKindFor = (feature: PackMapAreaFeature): OperationalAreaFeature['kind'] => {
  if (feature.id.startsWith('weather-grid:')) return 'weather-base'
  if (feature.id.startsWith('weather-cell:')) return 'weather-cell'
  return 'weather-influence'
}

const packAreaGeometrySignature = (
  feature: PackMapAreaFeature,
  kind: OperationalAreaFeature['kind'],
): string =>
  kind === 'weather-cell' || kind === 'weather-base'
    ? feature.id
    : polygonSignature(feature.geometry)

const baseGridPathFor = (feature: PackMapAreaFeature): OperationalPathFeature | null => {
  if (!feature.id.startsWith('weather-grid:')) return null
  const ring = feature.geometry.coordinates[0] ?? []
  return {
    id: `weather-grid:${feature.id}`,
    kind: 'weather-line',
    path: ring.map(coordinate => [coordinate[0], coordinate[1]] as const),
    color: colorWithAlpha(hexToRgba(feature.lineColor ?? feature.color), (feature.lineOpacity ?? 0.055) * 255),
    casingColor: colorWithAlpha(hexToRgba(feature.lineColor ?? feature.color), 0),
    widthPx: feature.lineWidth ?? 0.35,
    selected: false,
    priority: 5,
    signature: `weather-grid:${feature.id}:${feature.lineColor ?? feature.color}:${feature.lineOpacity ?? 0.055}:${feature.lineWidth ?? 0.35}`,
  }
}

const areaFor = (feature: PackMapAreaFeature): OperationalAreaFeature | null => {
  const kind = areaKindFor(feature)
  if (kind === 'weather-base') return null
  const opacity = feature.opacity ?? (kind === 'weather-cell' ? 0.12 : 0.10)
  const lineColor = feature.lineColor ?? feature.color
  return {
    id: `area:${feature.id}`,
    kind,
    polygon: feature.geometry,
    color: colorWithAlpha(hexToRgba(feature.color), opacity * 255),
    lineColor: colorWithAlpha(hexToRgba(lineColor), (feature.lineOpacity ?? 0.16) * 255),
    opacity,
    lineWidthPx: feature.lineWidth ?? 0.6,
    sortKey: feature.sortKey ?? 0,
    signature: `area:${feature.id}:${kind}:${feature.color}:${opacity}:${packAreaGeometrySignature(feature, kind)}`,
  }
}

const areaSymbolFor = (feature: PackMapAreaFeature): OperationalSymbolFeature | null => {
  if (!feature.anchorPoint || !feature.symbol) return null
  const tone = feature.symbol.tone ?? 'idle'
  const symbolId = normalizeSymbolId(feature.symbol.icon)
  const position = pointPosition(feature.anchorPoint)
  const opacity = feature.symbol.opacity ?? 0.92
  const sizePx = (feature.symbol.size ?? 0.82) * symbolSizePx(symbolId)
  return {
    id: `area-symbol:${feature.id}`,
    position,
    symbolId,
    color: colorWithAlpha(toneColor(tone), opacity * 255),
    opacity,
    sizePx,
    summary: feature.summary,
    signature: `area-symbol:${feature.id}:${positionSignature(position)}:${symbolId}:${tone}:${opacity}:${sizePx}`,
  }
}

const placementPosition = (point: GeoJsonPoint): Position3 =>
  pointPosition(point)

const projectFeatures = (input: OperationalRenderInput): {
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly paths: ReadonlyArray<OperationalPathFeature>
  readonly areas: ReadonlyArray<OperationalAreaFeature>
  readonly areaSymbols: ReadonlyArray<OperationalSymbolFeature>
  readonly placementPoints: ReadonlyArray<Position3>
} => {
  const context: MapFeatureProjectionContext = {
    selectedControllerId: input.selectedControllerId,
    highlightedObjectIds: new Set(input.highlightedObjectIds),
    hasNewInfo: input.hasNewInfo,
    presentationFor: input.presentationFor,
  }
  const points: OperationalPointFeature[] = []
  const paths: OperationalPathFeature[] = []
  const areas: OperationalAreaFeature[] = []
  for (const object of input.objects) {
    const point = operationalPointFor(object, context)
    if (point) points.push(point)
    const route = routePathFor(object, input.selectedControllerId)
    if (route) paths.push(route)
    const presentation = input.presentationFor(object)
    const line = lineObjectPathFor(object, presentation)
    if (line) paths.push(line)
    const area = trafficAreaFor(object, presentation)
    if (area) areas.push(area)
  }
  const packAreaPaths = input.packAreaFeatures.flatMap(feature => {
    const path = baseGridPathFor(feature)
    return path ? [path] : []
  })
  const areaFeatures = input.packAreaFeatures.flatMap(feature => {
    const area = areaFor(feature)
    return area ? [area] : []
  })
  const areaSymbols = input.packAreaFeatures.flatMap(feature => {
    const symbol = areaSymbolFor(feature)
    return symbol ? [symbol] : []
  })
  return {
    points: points.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
    paths: [...paths, ...packAreaPaths].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
    areas: [...areas, ...areaFeatures].sort((left, right) => left.sortKey - right.sortKey || left.id.localeCompare(right.id)),
    areaSymbols,
    placementPoints: input.placementPoints.map(placementPosition),
  }
}

export const createMapFeatureStore = (): MapFeatureStore => {
  const points = createFamilyState<OperationalPointFeature>()
  const paths = createFamilyState<OperationalPathFeature>()
  const areas = createFamilyState<OperationalAreaFeature>()
  const areaSymbols = createFamilyState<OperationalSymbolFeature>()
  let placementPoints: ReadonlyArray<Position3> = []
  let placementRevision = 0

  const currentSnapshot = (): OperationalRenderSnapshot => ({
    points: points.items,
    paths: paths.items,
    areas: areas.items,
    areaSymbols: areaSymbols.items,
    placementPoints,
    revisions: {
      points: points.revision,
      paths: paths.revision,
      areas: areas.revision,
      areaSymbols: areaSymbols.revision,
      placement: placementRevision,
    },
  })

  return {
    update: (input) => {
      const next = projectFeatures(input)
      syncFamily(points, next.points)
      syncFamily(paths, next.paths)
      syncFamily(areas, next.areas)
      syncFamily(areaSymbols, next.areaSymbols)
      const nextPlacementSignature = next.placementPoints.map(positionSignature).join('|')
      const currentPlacementSignature = placementPoints.map(positionSignature).join('|')
      if (nextPlacementSignature !== currentPlacementSignature) {
        placementPoints = next.placementPoints
        placementRevision += 1
      }
      return currentSnapshot()
    },
    snapshot: currentSnapshot,
  }
}

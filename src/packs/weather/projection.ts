import type { GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { nowIso } from '../../core/model/index.ts'
import { hexCellBoundary, hexCellResolution, hexCellsForPolygon, hexParentCell, hexResolution, type HexCellId } from '../../core/spatial/index.ts'
import type { PackMapAreaFeature } from '../../core/packs/protocol.ts'
import {
  activeWeatherInfluencesAt,
  activeWeatherInfluenceFrameAt,
  weatherInfluenceEllipsePolygon,
} from './influence.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'
import { weatherDomainDataSchema } from './model.ts'
import type { WeatherCellState, WeatherSparseField } from './cell-field.ts'

const maxBaseGridCells = 4_000
type WeatherPresentationSeverity = ReturnType<typeof weatherPresentationSeverityForState>

const visualResolutionForZoom = (zoom: number): number => {
  if (zoom < 7) return 5
  if (zoom < 9) return 6
  if (zoom < 11) return 7
  if (zoom < 13) return 8
  return 9
}

const boundedCellsForPolygon = (config: {
  readonly polygon: GeoJsonPolygon
  readonly preferredResolution: number
  readonly maxCells: number
}): { readonly resolution: number; readonly cells: ReadonlyArray<HexCellId> } => {
  for (let resolution = config.preferredResolution; resolution >= 0; resolution -= 1) {
    const cells = hexCellsForPolygon(config.polygon, hexResolution(resolution))
    if (cells.length <= config.maxCells || resolution === 0) return { resolution, cells }
  }
  return { resolution: 0, cells: [] }
}

const weatherCellColor = (severity: WeatherPresentationSeverity): string => {
  if (severity === 'hazard') return '#dc2626'
  if (severity === 'adverse') return '#d97706'
  if (severity === 'notice') return '#2563eb'
  return '#16834f'
}

const weatherCellOpacity = (severity: WeatherPresentationSeverity): number => {
  if (severity === 'hazard') return 0.16
  if (severity === 'adverse') return 0.12
  if (severity === 'notice') return 0.08
  return 0.035
}

const severityScore = (severity: WeatherPresentationSeverity): number => {
  if (severity === 'hazard') return 3
  if (severity === 'adverse') return 2
  if (severity === 'notice') return 1
  return 0
}

const influenceShapeColor = (severity: WeatherPresentationSeverity): string =>
  severity === 'hazard'
    ? '#dc2626'
    : severity === 'adverse'
      ? '#0ea5e9'
      : severity === 'notice'
        ? '#38bdf8'
        : '#22c55e'

const influenceShapeOpacity = (weight: number, normalizedRadius: number): number =>
  Math.max(0.018, Math.min(0.085, 0.018 + weight * 0.055 + (1 - normalizedRadius) * 0.012))

const baseGridFeatures = (config: {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}): ReadonlyArray<PackMapAreaFeature> => {
  const coverage = boundedCellsForPolygon({
    polygon: config.viewport,
    preferredResolution: visualResolutionForZoom(config.zoom),
    maxCells: maxBaseGridCells,
  })
  return coverage.cells.map(cellId => ({
    id: `weather-grid:${coverage.resolution}:${cellId}`,
    categoryId: 'weather',
    geometry: hexCellBoundary(cellId),
    color: '#64748b',
    opacity: 0,
    lineColor: '#2563eb',
    lineOpacity: 0.055,
    lineWidth: 0.35,
    sortKey: -10,
    summary: `weather grid resolution ${coverage.resolution}`,
  }))
}

const viewportBounds = (viewport: GeoJsonPolygon): {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
} => {
  const coordinates = viewport.coordinates.flatMap(ring => ring)
  if (coordinates.length === 0) throw new Error('weather map projection requires non-empty viewport coordinates')
  return coordinates.reduce((bounds, coordinate) => ({
    west: Math.min(bounds.west, coordinate[0]),
    south: Math.min(bounds.south, coordinate[1]),
    east: Math.max(bounds.east, coordinate[0]),
    north: Math.max(bounds.north, coordinate[1]),
  }), {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  })
}

const cellInBounds = (
  cell: WeatherCellState,
  bounds: ReturnType<typeof viewportBounds>,
): boolean => {
  const [lon, lat] = cell.center.coordinates
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north
}

const affectedCellFeaturesFromField = (config: {
  readonly field: WeatherSparseField
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}): ReadonlyArray<PackMapAreaFeature> => {
  const bounds = viewportBounds(config.viewport)
  const visualResolution = hexResolution(Math.min(visualResolutionForZoom(config.zoom), config.field.grid.truthResolution))
  const cellsById = new Map<HexCellId, {
    readonly severity: WeatherPresentationSeverity
    readonly activeInfluenceIds: ReadonlyArray<string>
    readonly changedCellCount: number
  }>()
  for (const cell of config.field.cells.values()) {
    if (!cellInBounds(cell, bounds)) continue
    const cellResolution = hexCellResolution(cell.id)
    const visualCell = cellResolution > visualResolution ? hexParentCell(cell.id, visualResolution) : cell.id
    const severity = weatherPresentationSeverityForState(cell.state)
    const previous = cellsById.get(visualCell)
    if (!previous || severityScore(severity) > severityScore(previous.severity)) {
      cellsById.set(visualCell, {
        severity,
        activeInfluenceIds: cell.activeInfluenceIds,
        changedCellCount: (previous?.changedCellCount ?? 0) + 1,
      })
    } else {
      cellsById.set(visualCell, {
        ...previous,
        changedCellCount: previous.changedCellCount + 1,
      })
    }
  }
  return [...cellsById.entries()].map(([cellId, cell]) => ({
    id: `weather-cell:${cellId}`,
    categoryId: 'weather',
    geometry: hexCellBoundary(cellId),
    color: weatherCellColor(cell.severity),
    opacity: weatherCellOpacity(cell.severity),
    lineColor: weatherCellColor(cell.severity),
    lineOpacity: cell.severity === 'normal' ? 0.04 : 0.09,
    lineWidth: 0.42,
    sortKey: 0,
    summary: cell.activeInfluenceIds.length > 0
      ? `weather affected by ${cell.activeInfluenceIds.join(', ')}`
      : `weather changed cells: ${cell.changedCellCount}`,
  }))
}

const influenceShapeFeatures = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
  readonly animationDurationMs?: number
}): ReadonlyArray<PackMapAreaFeature> =>
  activeWeatherInfluencesAt(config.objects, config.at).flatMap(influence => {
    const parsed = weatherDomainDataSchema.safeParse(config.objects.find(object => object.id === influence.objectId)?.domainData)
    if (parsed.success && parsed.data.render?.showInfluenceShape === false) return []
    const severity = weatherPresentationSeverityForState(influence.frame.state)
    const animationDurationMs = config.animationDurationMs ?? 0
    const toTime = new Date(Date.parse(config.at) + animationDurationMs).toISOString() as IsoTimestamp
    const toFrame = animationDurationMs > 0 && parsed.success
      ? activeWeatherInfluenceFrameAt(parsed.data, toTime)
      : null
    const geometry = weatherInfluenceEllipsePolygon(influence.frame)
    return [{
      id: `weather:${influence.objectId}`,
      categoryId: 'weather',
      geometry,
      ...(toFrame ? {
        animation: {
          fromGeometry: geometry,
          toGeometry: weatherInfluenceEllipsePolygon(toFrame),
          fromTime: config.at,
          toTime,
        },
      } : {}),
      color: influenceShapeColor(severity),
      opacity: influenceShapeOpacity(1, 0),
      lineColor: influenceShapeColor(severity),
      lineOpacity: 0.35,
      lineWidth: 1.4,
      sortKey: 10,
      summary: influence.label,
    }]
  })

export const projectWeatherFieldForMap = (config: {
  readonly field: WeatherSparseField
  readonly objects: ReadonlyArray<OperationalObject>
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly at?: IsoTimestamp
  readonly animationDurationMs?: number
}): ReadonlyArray<PackMapAreaFeature> => {
  const at = config.at ?? nowIso()
  return [
    ...baseGridFeatures({ viewport: config.viewport, zoom: config.zoom }),
    ...affectedCellFeaturesFromField({ field: config.field, viewport: config.viewport, zoom: config.zoom }),
    ...influenceShapeFeatures({
      objects: config.objects,
      at,
      ...(config.animationDurationMs === undefined ? {} : { animationDurationMs: config.animationDurationMs }),
    }),
  ]
}

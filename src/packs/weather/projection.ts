import type { GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { nowIso } from '../../core/model/index.ts'
import { hexCellBoundary, hexCellCenter, hexCellsForPolygon, hexResolution, type HexCellId } from '../../core/spatial/index.ts'
import type { PackMapAreaFeature } from '../../core/packs/protocol.ts'
import {
  activeWeatherInfluencesAt,
  weatherInfluenceEllipsePolygon,
  weatherInfluenceWeightForPoint,
} from './influence.ts'
import { weatherPresentationSeverityForState, weatherSampleAtPoint } from './conditions.ts'
import { weatherDomainDataSchema } from './model.ts'

const maxBaseGridCells = 4_000
const maxAffectedCells = 8_000

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

const affectedCellFeatures = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly at: IsoTimestamp
}): ReadonlyArray<PackMapAreaFeature> => {
  const resolution = visualResolutionForZoom(config.zoom)
  const cellsById = new Map<string, { readonly cellId: HexCellId; readonly summary: string }>()
  for (const influence of activeWeatherInfluencesAt(config.objects, config.at)) {
    const parsed = weatherDomainDataSchema.safeParse(config.objects.find(object => object.id === influence.objectId)?.domainData)
    if (parsed.success && parsed.data.render?.showAffectedCells === false) continue
    const coverage = boundedCellsForPolygon({
      polygon: weatherInfluenceEllipsePolygon(influence.frame),
      preferredResolution: resolution,
      maxCells: maxAffectedCells,
    })
    for (const cellId of coverage.cells) {
      const center = hexCellCenter(cellId)
      if (weatherInfluenceWeightForPoint(center, influence.frame) <= 0) continue
      cellsById.set(`${coverage.resolution}:${cellId}`, { cellId, summary: influence.label })
    }
  }
  return [...cellsById.values()].map(({ cellId, summary }) => {
    const sample = weatherSampleAtPoint(config.objects, hexCellCenter(cellId), config.at)
    const severity = weatherPresentationSeverityForState(sample.state)
    return {
      id: `weather-cell:${cellId}`,
      categoryId: 'weather',
      geometry: hexCellBoundary(cellId),
      color: weatherCellColor(severity),
      opacity: weatherCellOpacity(severity),
      lineColor: weatherCellColor(severity),
      lineOpacity: severity === 'normal' ? 0.045 : 0.11,
      lineWidth: 0.45,
      sortKey: 0,
      summary,
    }
  })
}

const influenceShapeFeatures = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): ReadonlyArray<PackMapAreaFeature> =>
  activeWeatherInfluencesAt(config.objects, config.at).flatMap(influence => {
    const parsed = weatherDomainDataSchema.safeParse(config.objects.find(object => object.id === influence.objectId)?.domainData)
    if (parsed.success && parsed.data.render?.showInfluenceShape === false) return []
    const severity = weatherPresentationSeverityForState(influence.frame.state)
    return [{
      id: `weather:${influence.objectId}`,
      categoryId: 'weather',
      geometry: weatherInfluenceEllipsePolygon(influence.frame),
      color: influenceShapeColor(severity),
      opacity: influenceShapeOpacity(1, 0),
      lineColor: influenceShapeColor(severity),
      lineOpacity: 0.35,
      lineWidth: 1.4,
      sortKey: 10,
      summary: influence.label,
    }]
  })

export const projectWeatherForMap = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly at?: IsoTimestamp
}): ReadonlyArray<PackMapAreaFeature> => {
  const at = config.at ?? nowIso()
  return [
    ...baseGridFeatures({ viewport: config.viewport, zoom: config.zoom }),
    ...affectedCellFeatures({ objects: config.objects, viewport: config.viewport, zoom: config.zoom, at }),
    ...influenceShapeFeatures({ objects: config.objects, at }),
  ]
}

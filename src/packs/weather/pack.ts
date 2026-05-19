import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import { nowIso } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { createWeatherAreaCommandKind } from './commands.ts'
import { weatherSampleAtPoint } from './conditions.ts'
import { renderedWeatherCellsForViewport, weatherInfluenceShapesForViewport } from './field.ts'
import {
  createWeatherAreaPayloadSchema,
  createWeatherProbePayloadSchema,
  weatherDomainDataSchema,
  weatherDomainId,
  type WeatherDomainData,
  type WeatherSeverity,
} from './model.ts'
import { weatherScenarioSupport } from './scenario.ts'
import { weatherSimProviderId } from './sim/constants.ts'

const parseWeatherData = (object: OperationalObject): WeatherDomainData | null => {
  const parsed = weatherDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const oneDecimal = (value: number): string =>
  `${Math.round(value * 10) / 10}`

const percent = (value: number | undefined): string =>
  value === undefined ? 'unknown' : `${Math.round(value * 100)}%`

const weatherFields = (data: WeatherDomainData): ReadonlyArray<PackObjectField> => [
  packField('air-temperature', 'Air temperature', `${oneDecimal(data.atmosphere.airTemperatureC)} °C`),
  packField('ground-temperature', 'Ground temperature', `${oneDecimal(data.surface.groundTemperatureC)} °C`),
  packField('precipitation', 'Precipitation', `${data.atmosphere.precipitation.type.replaceAll('_', ' ')} · ${oneDecimal(data.atmosphere.precipitation.intensityMmPerHour)} mm/h`),
  packField('humidity', 'Humidity', percent(data.atmosphere.humidity)),
  packField('visibility', 'Visibility', `${Math.round(data.atmosphere.visibilityM)} m`),
  packField('wind', 'Wind', `${oneDecimal(data.atmosphere.windSpeedMps)} m/s from ${Math.round(data.atmosphere.windDirectionDeg)}°`),
  packField('cloud-cover', 'Cloud cover', percent(data.atmosphere.cloudCover)),
  packField('surface', 'Surface', data.surface.labels.join(', ')),
  packField('wetness', 'Wetness', percent(data.surface.wetness)),
  packField('snow', 'Snow', percent(data.surface.snow)),
  packField('ice', 'Ice', percent(data.surface.ice)),
  packField('friction', 'Friction', data.surface.frictionClass),
]

const weatherValue = (data: Pick<WeatherDomainData, 'atmosphere' | 'surface'>): string => {
  const precipitation = data.atmosphere.precipitation
  return [
    `${oneDecimal(data.atmosphere.airTemperatureC)} °C air`,
    `${oneDecimal(data.surface.groundTemperatureC)} °C road`,
    precipitation.type === 'none'
      ? 'no precipitation'
      : `${precipitation.type.replaceAll('_', ' ')} ${oneDecimal(precipitation.intensityMmPerHour)} mm/h`,
    data.surface.frictionClass,
    `wet ${percent(data.surface.wetness)}`,
  ].join(' · ')
}

const weatherColor = (severity: WeatherSeverity | undefined, data: WeatherDomainData | null): string => {
  if (severity === 'hazard') return '#dc2626'
  if (severity === 'adverse') return '#d97706'
  if (severity === 'notice') {
    if (data?.atmosphere.precipitation.type === 'snow') return '#0891b2'
    return '#2563eb'
  }
  return '#16834f'
}

const weatherCellColor = (severity: WeatherSeverity): string => {
  if (severity === 'hazard') return '#dc2626'
  if (severity === 'adverse') return '#d97706'
  if (severity === 'notice') return '#2563eb'
  return '#16834f'
}

const weatherCellOpacity = (severity: WeatherSeverity): number => {
  if (severity === 'hazard') return 0.16
  if (severity === 'adverse') return 0.12
  if (severity === 'notice') return 0.08
  return 0.035
}

const influenceShapeColor = (severity: WeatherSeverity): string =>
  severity === 'hazard'
    ? '#dc2626'
    : severity === 'adverse'
      ? '#0ea5e9'
      : severity === 'notice'
        ? '#38bdf8'
        : '#22c55e'

const influenceShapeOpacity = (weight: number, normalizedRadius: number): number =>
  Math.max(0.018, Math.min(0.085, 0.018 + weight * 0.055 + (1 - normalizedRadius) * 0.012))

const statusToneFor = (severity: WeatherSeverity | undefined): 'ready' | 'working' | 'error' | 'idle' => {
  if (severity === 'hazard') return 'error'
  if (severity === 'adverse' || severity === 'notice') return 'working'
  return 'ready'
}

const samplePointFor = (object: OperationalObject): GeoJsonPoint | null => {
  if (object.domain === weatherDomainId) return null
  return object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)
}

const unsupportedCommand = (): PackCommandRequest => {
  throw new Error('weather pack does not support target commands')
}

const buildWeatherCreatePayload = (
  typeId: string,
  label: string,
  geometry: PackCreationGeometry,
  parameters: unknown,
): unknown => {
  if (typeId === 'weather_probe') {
    if (geometry.kind !== 'point') throw new Error(`weather probe creation requires point geometry, got ${geometry.kind}`)
    return createWeatherProbePayloadSchema.parse({
      objectType: 'weather_probe',
      label,
      point: geometry.point,
    })
  }
  if (typeId === 'weather_area') {
    if (geometry.kind !== 'point') throw new Error(`weather area creation requires point geometry, got ${geometry.kind}`)
    return createWeatherAreaPayloadSchema.parse({
      objectType: 'weather_area',
      label,
      center: geometry.point,
      ...(typeof parameters === 'object' && parameters !== null ? parameters : {}),
    })
  }
  throw new Error(`unsupported weather create type: ${typeId}`)
}

export const weatherPack: LeitbildPack = {
  id: 'weather',
  name: 'Weather Conditions',
  domain: weatherDomainId,
  simulationProviders: [
    { id: weatherSimProviderId, label: 'Local weather simulator', kind: 'local' },
  ],
  defaultSimulationProviderId: weatherSimProviderId,
  scenario: weatherScenarioSupport,
  categories: [
    {
      id: 'weather',
      label: 'Weather',
      emptyLabel: 'No weather conditions',
      matches: (object: OperationalObject): boolean => parseWeatherData(object) !== null,
    },
  ],
  createObjectTypes: [],
  presentObject: (object): PackObjectPresentation => {
    const data = parseWeatherData(object)
    const tone = statusToneFor(data?.severity)
    return {
      categoryId: 'weather',
      icon: 'weather',
      color: weatherColor(data?.severity, data),
      summary: data ? `${data.summary} · ${data.severity}` : object.operational.status,
      status: packStatus(tone, data ? `${data.severity} weather` : 'Invalid weather data'),
      fields: data ? weatherFields(data) : [packField('error', 'Error', 'Invalid weather domain data')],
      noteworthyUpdates: false,
    }
  },
  mapAreaFeatures: (context) => {
    if (!context.map) return []
    const at = context.currentTime ?? nowIso()
    const cells = renderedWeatherCellsForViewport({
      objects: context.objects,
      viewport: context.map.viewport,
      zoom: context.map.zoom,
      at,
    }).map(cell => ({
      id: `weather:${cell.id}`,
      categoryId: 'weather',
      geometry: cell.polygon,
      color: weatherCellColor(cell.sample.severity),
      opacity: weatherCellOpacity(cell.sample.severity),
      lineColor: weatherCellColor(cell.sample.severity),
      lineOpacity: cell.sample.severity === 'normal' ? 0.045 : 0.11,
      lineWidth: 0.45,
      sortKey: 0,
      summary: `${cell.sample.severity} weather`,
    }))
    const influenceShapes = weatherInfluenceShapesForViewport({
      objects: context.objects,
      viewport: context.map.viewport,
      zoom: context.map.zoom,
      at,
    }).map(shape => ({
      id: `weather:${shape.id}`,
      categoryId: 'weather',
      geometry: shape.polygon,
      color: influenceShapeColor(shape.severity),
      opacity: influenceShapeOpacity(shape.weight, shape.normalizedRadius),
      lineColor: influenceShapeColor(shape.severity),
      lineOpacity: shape.normalizedRadius >= 1 ? 0.35 : 0.06,
      lineWidth: shape.normalizedRadius >= 1 ? 1.4 : 0.4,
      sortKey: 10 + Math.round((1 - shape.normalizedRadius) * 10),
      summary: shape.summary,
    }))
    return [...cells, ...influenceShapes]
  },
  contextualFields: (object, context): ReadonlyArray<PackObjectField> => {
    const point = samplePointFor(object)
    if (!point) return []
    const sample = weatherSampleAtPoint(context.objects, point, context.currentTime ?? nowIso())
    return [packField('weather', 'Weather', weatherValue(sample))]
  },
  defaultObjectLabel: (typeId, context): string => {
    if (typeId !== 'weather_probe' && typeId !== 'weather_area') throw new Error(`unsupported weather create type: ${typeId}`)
    const count = context.objects.filter(object => parseWeatherData(object) !== null).length + 1
    return typeId === 'weather_probe' ? `Weather probe ${count}` : `Weather area ${count}`
  },
  buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest => ({
    kind: createWeatherAreaCommandKind,
    targetObjectIds: [],
    payload: buildWeatherCreatePayload(typeId, label, geometry, parameters),
  }),
  isController: () => false,
  isTarget: () => false,
  buildSetTargetCommand: (): PackCommandRequest => unsupportedCommand(),
  buildCancelTargetCommand: (): PackCommandRequest => unsupportedCommand(),
}

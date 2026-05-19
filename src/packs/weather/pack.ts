import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { createWeatherAreaCommandKind } from './commands.ts'
import {
  createWeatherAreaPayloadSchema,
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

const weatherColor = (severity: WeatherSeverity | undefined, data: WeatherDomainData | null): string => {
  if (severity === 'hazard') return '#dc2626'
  if (severity === 'adverse') return '#d97706'
  if (severity === 'notice') {
    if (data?.atmosphere.precipitation.type === 'snow') return '#0891b2'
    return '#2563eb'
  }
  return '#16834f'
}

const statusToneFor = (severity: WeatherSeverity | undefined): 'ready' | 'working' | 'error' | 'idle' => {
  if (severity === 'hazard') return 'error'
  if (severity === 'adverse' || severity === 'notice') return 'working'
  return 'ready'
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
  if (typeId !== 'weather_area') throw new Error(`unsupported weather create type: ${typeId}`)
  if (geometry.kind !== 'polygon') throw new Error(`weather area creation requires polygon geometry, got ${geometry.kind}`)
  const parsed = createWeatherAreaPayloadSchema.parse({
    objectType: 'weather_area',
    label,
    polygon: geometry.polygon,
    ...(typeof parameters === 'object' && parameters !== null ? parameters : {}),
  })
  return parsed
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
  createObjectTypes: [
    { id: 'weather_area', label: 'Weather area', categoryId: 'weather', icon: 'weather', color: '#2563eb', placementKind: 'polygon' },
  ],
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
  defaultObjectLabel: (typeId, context): string => {
    if (typeId !== 'weather_area') throw new Error(`unsupported weather create type: ${typeId}`)
    const count = context.objects.filter(object => parseWeatherData(object) !== null).length + 1
    return `Weather area ${count}`
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

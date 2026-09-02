import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import { nowIso } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { WorldPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { createWeatherAreaCommandKind } from './commands.ts'
import { weatherPresentationSeverityForState, weatherSampleAtPoint, type WeatherPresentationSeverity } from './conditions.ts'
import {
  createWeatherAreaPayloadSchema,
  createWeatherProbePayloadSchema,
  weatherPackDataSchema,
  weatherPackId,
  type WeatherPackData,
  type WeatherState,
} from './model.ts'
import { weatherPackConfigSchema, weatherScenarioSupport } from './scenario.ts'
import { weatherSimRuntimeId } from './sim/constants.ts'

const parseWeatherData = (object: OperationalObject): WeatherPackData | null => {
  const parsed = weatherPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

const oneDecimal = (value: number): string =>
  `${Math.round(value * 10) / 10}`

const percent = (value: number | undefined): string =>
  value === undefined ? 'unknown' : `${Math.round(value * 100)}%`

const surfaceSummary = (state: WeatherState): string => {
  const parts = [
    ...(state.surface.wetness > 0.2 ? ['wet'] : []),
    ...(state.surface.standingWater > 0.2 ? ['standing water'] : []),
    ...(state.surface.snow > 0.2 ? ['snow'] : []),
    ...(state.surface.ice > 0.2 ? ['ice'] : []),
    ...(state.surface.frost > 0.2 ? ['frost'] : []),
  ]
  return parts.length > 0 ? parts.join(', ') : 'dry'
}

const weatherFields = (data: WeatherPackData): ReadonlyArray<PackObjectField> => [
  packField('air-temperature', 'Air temperature', `${oneDecimal(data.state.atmosphere.airTemperatureC)} °C`),
  packField('ground-temperature', 'Ground temperature', `${oneDecimal(data.state.surface.groundTemperatureC)} °C`),
  packField('precipitation', 'Precipitation', `${data.state.atmosphere.precipitation.type.replaceAll('_', ' ')} · ${oneDecimal(data.state.atmosphere.precipitation.intensityMmPerHour)} mm/h`),
  packField('humidity', 'Humidity', percent(data.state.atmosphere.humidity)),
  packField('visibility', 'Visibility', `${Math.round(data.state.atmosphere.visibilityM)} m`),
  packField('wind', 'Wind', `${oneDecimal(data.state.atmosphere.windSpeedMps)} m/s from ${Math.round(data.state.atmosphere.windDirectionDeg)}°`),
  packField('cloud-cover', 'Cloud cover', percent(data.state.atmosphere.cloudCover)),
  packField('surface', 'Surface', surfaceSummary(data.state)),
  packField('wetness', 'Wetness', percent(data.state.surface.wetness)),
  packField('snow', 'Snow', percent(data.state.surface.snow)),
  packField('ice', 'Ice', percent(data.state.surface.ice)),
  ...Object.entries(data.state.extensions).map(([key, value]) => packField(`extension:${key}`, key, String(value))),
]

const weatherValue = (state: WeatherState): string => {
  const precipitation = state.atmosphere.precipitation
  return [
    `${oneDecimal(state.atmosphere.airTemperatureC)} °C air`,
    `${oneDecimal(state.surface.groundTemperatureC)} °C road`,
    precipitation.type === 'none'
      ? 'no precipitation'
      : `${precipitation.type.replaceAll('_', ' ')} ${oneDecimal(precipitation.intensityMmPerHour)} mm/h`,
    surfaceSummary(state),
    `wet ${percent(state.surface.wetness)}`,
  ].join(' · ')
}

const weatherMapFeatureLayersForZoom = (zoom: number): ReadonlyArray<'baseGrid' | 'affectedCells' | 'influenceShapes'> =>
  zoom < 7
    ? ['affectedCells', 'influenceShapes']
    : ['baseGrid', 'affectedCells', 'influenceShapes']

const weatherColor = (severity: WeatherPresentationSeverity | undefined, data: WeatherPackData | null): string => {
  if (severity === 'hazard') return '#dc2626'
  if (severity === 'adverse') return '#d97706'
  if (severity === 'notice') {
    if (data?.state.atmosphere.precipitation.type === 'snow') return '#0891b2'
    return '#2563eb'
  }
  return '#16834f'
}

const statusToneFor = (severity: WeatherPresentationSeverity | undefined): 'ready' | 'working' | 'error' | 'idle' => {
  if (severity === 'hazard') return 'error'
  if (severity === 'adverse' || severity === 'notice') return 'working'
  return 'ready'
}

const samplePointFor = (object: OperationalObject): GeoJsonPoint | null => {
  if (object.packId === weatherPackId) return null
  return object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)
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

export const weatherPack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: 'weather', version: '1.0.0', name: 'Weather Conditions',
    contributions: ['runtime', 'scenario', 'presentation', 'creation'],
  }),
  scenarioConfigSchema: weatherPackConfigSchema,
  authoring: {
    itemTypes: [{
      id: 'weather_condition',
      label: 'Weather area',
      description: 'A stationary weather influence area with editable size and conditions.',
      idPrefix: 'weather',
      defaultItem: {
        summary: 'Configured weather area',
        truthResolution: 8,
        showAffectedCells: true,
        showInfluenceShape: true,
        showIcon: true,
        priority: 0,
        atmosphere: {
          airTemperatureC: 8,
          humidity: 0.75,
          windSpeedMps: 4,
          windDirectionDeg: 220,
          visibilityM: 10_000,
          cloudCover: 0.7,
          precipitation: { type: 'rain', intensityMmPerHour: 1 },
        },
        surface: { groundTemperatureC: 7, wetness: 0.25, standingWater: 0, snow: 0, ice: 0, frost: 0 },
        extensions: {},
        falloffCurve: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
        keyframes: [{
          atSeconds: 0,
          center: [10.7522, 59.9139],
          semiMajorAxisM: 4_000,
          semiMinorAxisM: 2_000,
          rotationDeg: 0,
          atmosphere: {},
          surface: {},
          extensions: {},
        }],
      },
      placement: { target: 'item', path: ['keyframes', 0, 'center'] },
      fields: [{
        target: 'item', path: ['summary'], label: 'Summary',
        control: { kind: 'text', defaultValue: 'Configured weather area' },
      }, {
        target: 'item', path: ['keyframes', 0, 'semiMajorAxisM'], label: 'Length radius (m)',
        control: { kind: 'number', defaultValue: 4_000, min: 100, step: 100 },
      }, {
        target: 'item', path: ['keyframes', 0, 'semiMinorAxisM'], label: 'Width radius (m)',
        control: { kind: 'number', defaultValue: 2_000, min: 100, step: 100 },
      }, {
        target: 'item', path: ['atmosphere', 'airTemperatureC'], label: 'Air temperature (°C)',
        control: { kind: 'number', defaultValue: 8, step: 1 },
      }, {
        target: 'item', path: ['atmosphere', 'precipitation', 'intensityMmPerHour'], label: 'Rain (mm/h)',
        control: { kind: 'number', defaultValue: 1, min: 0, step: 0.1 },
      }],
    }],
  },
  runtime: {
    runtimes: [{ id: weatherSimRuntimeId, version: '1.0.0', label: 'Local weather runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: weatherSimRuntimeId,
  },
  scenario: weatherScenarioSupport,
  presentation: {
    categories: [{
      id: 'weather',
      label: 'Weather',
      emptyLabel: 'No weather conditions',
      matches: (object: OperationalObject): boolean => parseWeatherData(object) !== null,
    }],
    mapAreaFeatureLayers: ['weather'],
    mapAreaFeatureSourcePackIds: [weatherPackId],
    presentObject: (object): PackObjectPresentation => {
    const data = parseWeatherData(object)
    const severity = data ? weatherPresentationSeverityForState(data.state) : undefined
    const tone = statusToneFor(severity)
    return {
      categoryId: 'weather',
      icon: 'weather',
      color: weatherColor(severity, data),
      summary: data ? `${data.summary} · ${severity}` : object.operational.status,
      status: packStatus(tone, data ? `${severity} weather` : 'Invalid weather data'),
      fields: data ? weatherFields(data) : [packField('error', 'Error', 'Invalid weather pack data')],
      mapIconVisible: data?.conditionKind !== 'weather_influence',
      noteworthyUpdates: false,
    }
    },
    mapAreaFeatureQueries: (context) => context.map
    ? [{
        capabilityId: 'world.weather.map-features',
        input: {
          viewport: context.map.viewport,
          zoom: context.map.zoom,
          ...(context.currentTime ? { at: context.currentTime } : {}),
          animationDurationMs: 2_000,
          layers: weatherMapFeatureLayersForZoom(context.map.zoom),
        },
      }]
    : [],
    contextualFields: (object, context): ReadonlyArray<PackObjectField> => {
      const point = samplePointFor(object)
      if (!point) return []
      const weatherObjects = context.objectsForPack?.(weatherPackId)
        ?? context.objects.filter(candidate => candidate.packId === weatherPackId)
      const sample = weatherSampleAtPoint(weatherObjects, point, context.currentTime ?? nowIso())
      return [packField('weather', 'Weather', weatherValue(sample.state))]
    },
  },
  creation: {
    createObjectTypes: [
      { id: 'weather_probe', label: 'Weather probe', categoryId: 'weather', icon: 'weather', color: '#2563eb', placementKind: 'point' },
      { id: 'weather_area', label: 'Weather area', categoryId: 'weather', icon: 'weather', color: '#2563eb', placementKind: 'point' },
    ],
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
  },
}

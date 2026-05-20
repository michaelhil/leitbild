import type {
  CommandEnvelope,
  CommandResult,
  DomainEvent,
  GeoJsonPoint,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  SimulationClockState,
} from '../../../core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEvent,
  SimulationEventHandler,
} from '../../../simulation/protocol.ts'
import {
  createWeatherSparseField,
  updateWeatherSparseField,
  weatherGridForObjects,
  type WeatherSparseField,
} from '../cell-field.ts'
import { createWeatherAreaCommandKind } from '../commands.ts'
import { weatherSampleAtPoint } from '../conditions.ts'
import { defaultAtmosphere, defaultSurface } from '../defaults.ts'
import { weatherDataAtTime, weatherObjectCurrentCenter } from '../field.ts'
import {
  createWeatherConditionPayloadSchema,
  weatherAtmosphereSchema,
  weatherDomainDataSchema,
  weatherDomainId,
  weatherInfluenceSchema,
  weatherSurfaceSchema,
  type CreateWeatherAreaPayload,
  type WeatherDomainData,
  type WeatherSample,
  type WeatherState,
} from '../model.ts'
import { createWeatherDomainData } from '../scenario.ts'
import { weatherSimAdapterId, weatherSimDomain, weatherSimProviderId } from './constants.ts'

const updateIntervalMs = 5_000
const minimumSurfaceDelta = 0.01

const restoreWeatherObject = (object: OperationalObject): OperationalObject => {
  const parsed = weatherDomainDataSchema.safeParse(object.domainData)
  if (!parsed.success) throw new Error(`invalid restored weather object domain data for ${object.id}: ${parsed.error.message}`)
  return { ...object, domainData: parsed.data }
}

const nextNumberAfter = (objects: Iterable<OperationalObject>): number => {
  let highest = 0
  for (const object of objects) {
    const match = object.id.match(/^weather:condition-(\d+)$/)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isInteger(value) && value > highest) highest = value
  }
  return highest + 1
}

const emit = (
  handlers: ReadonlySet<SimulationEventHandler>,
  events: ReadonlyArray<SimulationEvent>,
  at: IsoTimestamp,
): void => {
  if (events.length === 0) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      providerId: weatherSimProviderId,
      emittedAt: at,
      events,
    })
  }
}

const spatialFor = (config: {
  readonly point?: GeoJsonPoint
  readonly at: IsoTimestamp
}): OperationalObject['spatial'] => {
  const point = config.point
  return {
    ...(point ? {
      position: {
        point,
        observedAt: config.at,
        staleAfterMs: 600000,
      },
    } : {}),
    frame: { kind: 'wgs84' },
  }
}

const operationalStatusFor = (): OperationalObject['operational'] => ({
  status: 'active',
  priority: 'low',
  mode: 'simulated',
})

const createWeatherConditionObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly point?: GeoJsonPoint
  readonly data: WeatherDomainData
  readonly at: IsoTimestamp
  readonly causedByCommandId?: CommandEnvelope['id']
}): OperationalObject => ({
  id: config.id,
  kind: 'zone',
  domain: weatherSimDomain,
  label: config.label,
  lifecycle: 'active',
  revision: 0,
  spatial: spatialFor(config),
  operational: operationalStatusFor(),
  alerts: [],
  provenance: {
    source: config.causedByCommandId ? 'operator' : 'simulator',
    adapterId: weatherSimAdapterId,
    externalId: config.id,
    ...(config.causedByCommandId ? { causedByCommandId: config.causedByCommandId } : {}),
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  domainData: config.data,
})

const weatherProbeDataFromSample = (config: {
  readonly sample: WeatherSample
  readonly at: IsoTimestamp
  readonly summary: string
}): WeatherDomainData => weatherDomainDataSchema.parse({
  type: 'weather_condition',
  schemaVersion: 1,
  conditionKind: 'point_observation',
  state: config.sample.state,
  quality: {
    ...config.sample.quality,
    provenance: config.sample.activeInfluenceIds.length > 0 ? 'inferred' : config.sample.quality.provenance,
    validAt: config.at,
  },
  summary: config.summary,
})

const resampleWeatherProbe = (
  object: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
  at: IsoTimestamp,
): OperationalObject | null => {
  const previous = weatherDomainDataSchema.parse(object.domainData)
  if (previous.conditionKind !== 'point_observation') return null
  const point = object.spatial.position?.point
  if (!point) throw new Error(`weather probe ${object.id} is missing a point`)
  const sample = weatherSampleAtPoint(objects, point, at)
  const next = weatherProbeDataFromSample({
    sample,
    at,
    summary: previous.summary,
  })
  if (!dataChangedMeaningfully(previous, next)) return null
  return {
    ...object,
    revision: object.revision + 1,
    operational: operationalStatusFor(),
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
    domainData: next,
  }
}

const dataChangedMeaningfully = (previous: WeatherDomainData, next: WeatherDomainData): boolean => (
  previous.state.atmosphere.precipitation.type !== next.state.atmosphere.precipitation.type ||
  Math.abs(previous.state.atmosphere.precipitation.intensityMmPerHour - next.state.atmosphere.precipitation.intensityMmPerHour) >= 0.05 ||
  Math.abs(previous.state.atmosphere.airTemperatureC - next.state.atmosphere.airTemperatureC) >= 0.1 ||
  Math.abs(previous.state.surface.groundTemperatureC - next.state.surface.groundTemperatureC) >= 0.1 ||
  Math.abs(previous.state.surface.wetness - next.state.surface.wetness) >= minimumSurfaceDelta ||
  Math.abs(previous.state.surface.snow - next.state.surface.snow) >= minimumSurfaceDelta ||
  Math.abs(previous.state.surface.ice - next.state.surface.ice) >= minimumSurfaceDelta ||
  Math.abs(previous.state.surface.frost - next.state.surface.frost) >= minimumSurfaceDelta ||
  JSON.stringify(previous.state.extensions) !== JSON.stringify(next.state.extensions)
)

const pointChangedMeaningfully = (previous: GeoJsonPoint | undefined, next: GeoJsonPoint | null): boolean => {
  if (!previous && !next) return false
  if (!previous || !next) return true
  return (
    Math.abs(previous.coordinates[0] - next.coordinates[0]) > 0.000001 ||
    Math.abs(previous.coordinates[1] - next.coordinates[1]) > 0.000001
  )
}

const createOperatorWeatherAreaData = (
  payload: CreateWeatherAreaPayload,
  at: IsoTimestamp,
): WeatherDomainData => {
  if (!payload.center || payload.semiMajorAxisM === undefined || payload.semiMinorAxisM === undefined) {
    throw new Error('weather area creation requires center, semiMajorAxisM, and semiMinorAxisM')
  }
  const atmosphere = weatherAtmosphereSchema.parse({
    ...defaultAtmosphere(at),
    ...payload.atmosphere,
    precipitation: {
      ...defaultAtmosphere(at).precipitation,
      ...payload.atmosphere?.precipitation,
    },
  })
  const surface = weatherSurfaceSchema.parse({
    ...defaultSurface(),
    ...payload.surface,
  })
  const state: WeatherState = { atmosphere, surface, extensions: payload.extensions ?? {} }
  const influence = weatherInfluenceSchema.parse({
    priority: 0,
    keyframes: [{
      atSeconds: 0,
      center: payload.center,
      semiMajorAxisM: payload.semiMajorAxisM,
      semiMinorAxisM: payload.semiMinorAxisM,
      rotationDeg: payload.rotationDeg,
      state,
      falloffCurve: payload.falloffCurve,
    }],
  })
  const data = createWeatherDomainData({
    at,
    summary: payload.summary,
    state,
    influence,
  })
  return {
    ...data,
    quality: {
      ...data.quality,
      provenance: 'intervention',
    },
  }
}

export const createLocalWeatherSimulationAdapter = (): SimulationAdapter => ({
  id: weatherSimProviderId,
  domain: weatherDomainId,
  acceptedCommandKinds: [createWeatherAreaCommandKind],
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const objects = new Map<string, OperationalObject>()
    const initialObjects = (config.initialObjects ?? config.scenario?.initialObjects ?? [])
      .filter(object => object.domain === weatherDomainId)
    for (const object of initialObjects) objects.set(object.id, restoreWeatherObject(object))
    let nextConditionNumber = nextNumberAfter(objects.values())
    const handlers = new Set<SimulationEventHandler>()
    const startedAt = nowIso()
    let clock: SimulationClockState = { currentTime: startedAt, updatedAt: startedAt, paused: false, speed: 1 }
    let lastTickWallMs = Date.now()
    let sparseField: WeatherSparseField = createWeatherSparseField(weatherGridForObjects({
      gridId: `${config.controlInstanceId}:weather`,
      objects: [...objects.values()],
      fallbackPoint: objects.values().next().value?.spatial.position?.point ?? geoPointFromLonLat(0, 0),
    }))

    const advance = (): void => {
      const nowWallMs = Date.now()
      const elapsedSeconds = clock.paused ? 0 : ((nowWallMs - lastTickWallMs) / 1000) * clock.speed
      lastTickWallMs = nowWallMs
      if (elapsedSeconds <= 0) return
      const at = new Date(Date.parse(clock.currentTime) + elapsedSeconds * 1000).toISOString() as IsoTimestamp
      clock = { ...clock, currentTime: at, updatedAt: nowIso() }
      const events: SimulationEvent[] = []
      for (const object of objects.values()) {
        const previous = weatherDomainDataSchema.parse(object.domainData)
        if (previous.conditionKind === 'point_observation') continue
        const next = weatherDataAtTime(previous, at)
        const center = weatherObjectCurrentCenter(next, at)
        if (!dataChangedMeaningfully(previous, next) && !pointChangedMeaningfully(object.spatial.position?.point, center)) continue
        const updated: OperationalObject = {
          ...object,
          revision: object.revision + 1,
          spatial: spatialFor({ ...(center ? { point: center } : {}), at }),
          operational: operationalStatusFor(),
          timestamps: {
            ...object.timestamps,
            updatedAt: at,
          },
          domainData: next,
        }
        objects.set(updated.id, updated)
        events.push({
          type: 'object.upserted',
          object: updated,
          at,
          provenance: updated.provenance,
        })
      }
      const weatherObjectsAfterZoneEvolution = [...objects.values()]
      sparseField = updateWeatherSparseField({
        field: sparseField,
        objects: weatherObjectsAfterZoneEvolution,
        at,
        elapsedSeconds,
      }).field
      for (const object of weatherObjectsAfterZoneEvolution) {
        const updated = resampleWeatherProbe(object, weatherObjectsAfterZoneEvolution, at)
        if (!updated) continue
        objects.set(updated.id, updated)
        events.push({
          type: 'object.upserted',
          object: updated,
          at,
          provenance: updated.provenance,
        })
      }
      emit(handlers, events, at)
    }

    const interval = setInterval(advance, updateIntervalMs)

    return {
      getSnapshot: async () => ({
        controlInstanceId: config.controlInstanceId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (command.kind !== createWeatherAreaCommandKind) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: `weather provider does not accept command kind: ${command.kind}`,
          }
        }
        const payload = createWeatherConditionPayloadSchema.safeParse(command.payload)
        if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
        const object = payload.data.objectType === 'weather_probe'
          ? createWeatherConditionObject({
              id: `weather:condition-${nextConditionNumber++}` as ObjectId,
              label: payload.data.label,
              point: payload.data.point,
              data: weatherProbeDataFromSample({
                sample: weatherSampleAtPoint([...objects.values()], payload.data.point, acceptedAt),
                at: acceptedAt,
                summary: 'Weather probe sample',
              }),
              at: acceptedAt,
              causedByCommandId: command.id,
            })
          : createWeatherConditionObject({
              id: `weather:condition-${nextConditionNumber++}` as ObjectId,
              label: payload.data.label,
              ...(payload.data.center ? { point: payload.data.center } : {}),
              data: createOperatorWeatherAreaData(payload.data, acceptedAt),
              at: acceptedAt,
              causedByCommandId: command.id,
            })
        objects.set(object.id, object)
        emit(handlers, [{
          type: 'object.upserted',
          object,
          at: acceptedAt,
          provenance: object.provenance,
        }], acceptedAt)
        return { ok: true, commandId: command.id, acceptedAt }
      },
      observeCommittedEvents: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.upserted' && event.object.domain === weatherDomainId) objects.set(event.object.id, restoreWeatherObject(event.object))
          if (event.type === 'object.deleted') objects.delete(event.objectId)
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastTickWallMs = Date.now()
      },
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})

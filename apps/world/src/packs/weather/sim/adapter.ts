import type {
  CommandEnvelope,
  CommandResult,
  SimulationRunEvent,
  GeoJsonPoint,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  SimulationClockState,
} from '../../../core/model/index.ts'
import { commandResultSchema, geoPointFromLonLat, nowIso } from '../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeQuery,
} from '../../../simulation/protocol.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import {
  createWeatherSparseField,
  updateWeatherSparseField,
  weatherSampleAtPointFromSparseField,
  weatherGridForObjects,
  type WeatherSparseField,
} from '../cell-field.ts'
import { createWeatherAreaCommandKind } from '../commands.ts'
import { defaultAtmosphere, defaultSurface } from '../defaults.ts'
import { weatherDataAtTime, weatherObjectCurrentCenter } from '../influence.ts'
import {
  createWeatherConditionPayloadSchema,
  weatherAtmosphereSchema,
  weatherPackDataSchema,
  weatherPackId,
  weatherInfluenceSchema,
  weatherSurfaceSchema,
  type CreateWeatherAreaPayload,
  type WeatherPackData,
  type WeatherSample,
  type WeatherState,
} from '../model.ts'
import { createWeatherPackData } from '../scenario.ts'
import { answerWeatherQuery, weatherQueryCapabilities } from '../query.ts'
import { weatherSimAdapterId, weatherSimPackId, weatherSimRuntimeId } from './constants.ts'

const updateIntervalMs = 5_000
const minimumSurfaceDelta = 0.01

const restoreWeatherObject = (object: OperationalObject): OperationalObject => {
  const parsed = weatherPackDataSchema.safeParse(object.packData)
  if (!parsed.success) throw new Error(`invalid restored weather object pack data for ${object.id}: ${parsed.error.message}`)
  return { ...object, packData: parsed.data }
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
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
  at: IsoTimestamp,
): void => {
  if (events.length === 0) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      runtimeId: weatherSimRuntimeId,
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
  readonly data: WeatherPackData
  readonly at: IsoTimestamp
  readonly causedByCommandId?: CommandEnvelope['id']
}): OperationalObject => ({
  id: config.id,
  kind: 'zone',
  packId: weatherSimPackId,
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
  packData: config.data,
})

const weatherProbeDataFromSample = (config: {
  readonly sample: WeatherSample
  readonly at: IsoTimestamp
  readonly summary: string
}): WeatherPackData => weatherPackDataSchema.parse({
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
  field: WeatherSparseField,
  at: IsoTimestamp,
): OperationalObject | null => {
  const previous = weatherPackDataSchema.parse(object.packData)
  if (previous.conditionKind !== 'point_observation') return null
  const point = object.spatial.position?.point
  if (!point) throw new Error(`weather probe ${object.id} is missing a point`)
  const sample = weatherSampleAtPointFromSparseField({ field, point, at })
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
    packData: next,
  }
}

const dataChangedMeaningfully = (previous: WeatherPackData, next: WeatherPackData): boolean => (
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
): WeatherPackData => {
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
  const data = createWeatherPackData({
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

export const createLocalWeatherPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: weatherSimRuntimeId,
  version: '1.0.0',
  packId: weatherPackId,
  clock: 'simulation',
  capabilities: [
    defineSimulationCommandCapability({ id: createWeatherAreaCommandKind, title: 'Create weather condition', description: 'Creates a weather influence area or point observation with explicit geometry and conditions.', input: createWeatherConditionPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [], payload: createWeatherConditionPayloadSchema.parse(input) }) }),
    ...weatherQueryCapabilities,
  ],
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const objects = new Map<string, OperationalObject>()
    const initialObjects = (config.initialObjects ?? config.scenario.initialObjects)
      .filter(object => object.packId === weatherPackId)
    for (const object of initialObjects) objects.set(object.id, restoreWeatherObject(object))
    let nextConditionNumber = nextNumberAfter(objects.values())
    const handlers = new Set<PackRuntimeEventHandler>()
    const startedAt = config.scenario.world.startsAt
    let clock: SimulationClockState = { currentTime: startedAt, updatedAt: startedAt, paused: false, speed: 1 }
    let lastTickWallMs = Date.now()
    let sparseField: WeatherSparseField = createWeatherSparseField(weatherGridForObjects({
      gridId: `${config.simulationRunId}:weather`,
      objects: [...objects.values()],
      fallbackPoint: objects.values().next().value?.spatial.position?.point ?? geoPointFromLonLat(0, 0),
    }))
    sparseField = updateWeatherSparseField({
      field: sparseField,
      objects: [...objects.values()],
      at: clock.currentTime,
      elapsedSeconds: 0,
    }).field

    const advance = (): void => {
      const nowWallMs = Date.now()
      const elapsedSeconds = clock.paused ? 0 : ((nowWallMs - lastTickWallMs) / 1000) * clock.speed
      lastTickWallMs = nowWallMs
      if (elapsedSeconds <= 0) return
      const at = new Date(Date.parse(clock.currentTime) + elapsedSeconds * 1000).toISOString() as IsoTimestamp
      clock = { ...clock, currentTime: at, updatedAt: nowIso() }
      const events: PackRuntimeEvent[] = []
      for (const object of objects.values()) {
        const previous = weatherPackDataSchema.parse(object.packData)
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
          packData: next,
        }
        objects.set(updated.id, updated)
        events.push({
          type: 'object.upserted',
          object: updated,
          at,
          history: 'snapshot-only',
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
        const updated = resampleWeatherProbe(object, sparseField, at)
        if (!updated) continue
        objects.set(updated.id, updated)
        events.push({
          type: 'object.upserted',
          object: updated,
          at,
          history: 'snapshot-only',
          provenance: updated.provenance,
        })
      }
      emit(handlers, events, at)
    }

    const interval = setInterval(advance, updateIntervalMs)

    return {
      getSnapshot: async () => ({
        simulationRunId: config.simulationRunId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
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
            reason: `weather runtime does not accept command kind: ${command.kind}`,
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
                sample: weatherSampleAtPointFromSparseField({ field: sparseField, point: payload.data.point, at: acceptedAt }),
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
        sparseField = updateWeatherSparseField({
          field: sparseField,
          objects: [...objects.values()],
          at: acceptedAt,
          elapsedSeconds: 0,
        }).field
        emit(handlers, [{
          type: 'object.upserted',
          object,
          at: acceptedAt,
          history: 'record',
          provenance: object.provenance,
        }], acceptedAt)
        return { ok: true, commandId: command.id, acceptedAt }
      },
      invokeQuery: async (request: PackRuntimeQuery): Promise<unknown> =>
        answerWeatherQuery({
          request,
          field: sparseField,
          objects: [...objects.values()],
          at: clock.currentTime,
        }),
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        let changed = false
        for (const event of events) {
          if (event.type === 'object.upserted' && event.object.packId === weatherPackId) {
            objects.set(event.object.id, restoreWeatherObject(event.object))
            changed = true
          }
          if (event.type === 'object.deleted') {
            changed = objects.delete(event.objectId) || changed
          }
        }
        if (changed) {
          sparseField = updateWeatherSparseField({
            field: sparseField,
            objects: [...objects.values()],
            at: clock.currentTime,
            elapsedSeconds: 0,
          }).field
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastTickWallMs = Date.now()
        sparseField = updateWeatherSparseField({
          field: sparseField,
          objects: [...objects.values()],
          at: clock.currentTime,
          elapsedSeconds: 0,
        }).field
      },
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})

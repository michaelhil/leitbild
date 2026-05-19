import type {
  CommandEnvelope,
  CommandResult,
  DomainEvent,
  GeoJsonPolygon,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  SimulationClockState,
} from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEvent,
  SimulationEventHandler,
} from '../../../simulation/protocol.ts'
import { createWeatherAreaCommandKind } from '../commands.ts'
import { evolveWeatherData } from '../conditions.ts'
import { createWeatherConditionPayloadSchema, weatherDomainDataSchema, weatherDomainId, type WeatherDomainData } from '../model.ts'
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

type WeatherPriority = NonNullable<OperationalObject['operational']['priority']>

const severityPriority = (severity: WeatherDomainData['severity']): WeatherPriority =>
  severity === 'hazard' ? 'high' : severity === 'adverse' ? 'normal' : 'low'

const createWeatherConditionObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly geometry: GeoJsonPolygon
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
  spatial: {
    geometry: config.geometry,
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: config.data.severity,
    priority: severityPriority(config.data.severity),
    mode: 'simulated',
  },
  alerts: config.data.severity === 'hazard'
    ? [{
        id: `${config.id}:weather`,
        kind: 'weather_condition',
        severity: 'warning',
        message: config.data.summary,
        raisedAt: config.at,
        acknowledged: false,
      }]
    : [],
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

const dataChangedMeaningfully = (previous: WeatherDomainData, next: WeatherDomainData): boolean => (
  previous.severity !== next.severity ||
  previous.atmosphere.precipitation.type !== next.atmosphere.precipitation.type ||
  Math.abs(previous.atmosphere.precipitation.intensityMmPerHour - next.atmosphere.precipitation.intensityMmPerHour) >= 0.05 ||
  Math.abs(previous.atmosphere.airTemperatureC - next.atmosphere.airTemperatureC) >= 0.1 ||
  Math.abs(previous.surface.groundTemperatureC - next.surface.groundTemperatureC) >= 0.1 ||
  Math.abs(previous.surface.wetness - next.surface.wetness) >= minimumSurfaceDelta ||
  Math.abs(previous.surface.snow - next.surface.snow) >= minimumSurfaceDelta ||
  Math.abs(previous.surface.ice - next.surface.ice) >= minimumSurfaceDelta ||
  Math.abs(previous.surface.frost - next.surface.frost) >= minimumSurfaceDelta
)

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
        const next = evolveWeatherData(previous, at, elapsedSeconds)
        if (!dataChangedMeaningfully(previous, next)) continue
        const updated: OperationalObject = {
          ...object,
          revision: object.revision + 1,
          operational: {
            ...object.operational,
            status: next.severity,
            priority: severityPriority(next.severity),
          },
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
        const data = createWeatherDomainData({
          at: acceptedAt,
          summary: payload.data.summary,
          severity: payload.data.severity,
          ...(payload.data.atmosphere ? { atmosphere: payload.data.atmosphere } : {}),
          ...(payload.data.surface ? { surface: payload.data.surface } : {}),
        })
        const object = createWeatherConditionObject({
          id: `weather:condition-${nextConditionNumber++}` as ObjectId,
          label: payload.data.label,
          geometry: payload.data.polygon,
          data: { ...data, quality: { ...data.quality, provenance: 'intervention' } },
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

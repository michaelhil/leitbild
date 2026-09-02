import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CommandEnvelope,CommandResult,GeoJsonPoint,InteractionSignal,IsoTimestamp,OperationalObject,PackRuntimeRecordingBatch,SignalId,SimulationClockState } from '../../../core/model/index.ts'
import { assetRoutePlannedSignalType,commandResultSchema,interactionSignalSchema,nowIso } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { defineSimulationCommandCapability,defineSimulationQueryCapability } from '../../../simulation/capabilities.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeHealth,
  PackRuntimeQuery,
} from '../../../simulation/protocol.ts'
import {
  assignToIncidentCommandKind,
  assignToIncidentPayloadSchema,
  cancelDestinationCommandKind,
  cancelDestinationPayloadSchema,
  createIncidentCommandKind,createIncidentPayloadSchema,
  createObjectCommandKind,
  createObjectPayloadSchema,
  setDestinationCommandKind,
  setDestinationPayloadSchema,
  setIncidentVictimsCommandKind,setIncidentVictimsPayloadSchema,
} from '../commands.ts'
import { ambulancePackDataSchema,ambulancePackId,hospitalPackDataSchema,incidentPackDataSchema } from '../model.ts'
import { ambulanceQueryCapabilities,answerAmbulanceQuery } from '../query.ts'
import { createAmbulanceRecordingPlan } from '../recording.ts'
import {
  ambulancePackConfigSchema,
  roadWeatherCapability,
  roadWeatherImpact,
  roadWeatherPolicySchema,
  roadWeatherSamplesSchema,
  setRoadWeatherPolicyCapability,
} from '../road-weather.ts'
import { ambulanceSimAdapterId,ambulanceSimRuntimeId } from './constants.ts'
import { createAmbulanceSimEngine } from './engine.ts'

const emit = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
  recording?: PackRuntimeRecordingBatch,
): void => {
  const firstEvent = events[0]
  if (!firstEvent && recording === undefined) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      ...(recording === undefined ? {} : { recording }),
      emittedAt: firstEvent?.at ?? nowIso(),
      runtimeId: ambulanceSimRuntimeId,
    })
  }
}

const validateAmbulanceRuntimeObject = (object: OperationalObject): OperationalObject => {
  if (object.kind === 'mobile_entity') {
    const parsed = ambulancePackDataSchema.safeParse(object.packData)
    if (!parsed.success) throw new Error(`invalid ambulance object pack data for ${object.id}: ${parsed.error.message}`)
    return { ...object, packData: parsed.data }
  }
  if (object.kind === 'facility') {
    const parsed = hospitalPackDataSchema.safeParse(object.packData)
    if (!parsed.success) throw new Error(`invalid hospital object pack data for ${object.id}: ${parsed.error.message}`)
    return { ...object, packData: parsed.data }
  }
  if (object.kind === 'incident') {
    const parsed = incidentPackDataSchema.safeParse(object.packData)
    if (!parsed.success) throw new Error(`invalid incident object pack data for ${object.id}: ${parsed.error.message}`)
    return { ...object, packData: parsed.data }
  }
  throw new Error(`unsupported ambulance runtime object kind for ${object.id}: ${object.kind}`)
}

const initialObjectsFor = (config: PackRuntimeConnectionConfig): ReadonlyArray<OperationalObject> => {
  const objects = config.initialObjects ?? config.scenario.initialObjects
  if (!objects) throw new Error(`ambulance runtime requires scenario or restored objects for simulation run ${config.simulationRunId}`)
  return objects
    .filter(object => object.packId === ambulancePackId)
    .map(validateAmbulanceRuntimeObject)
}

const pointForTarget = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (point) return point
  if (object.spatial.geometry?.type === 'Point') return object.spatial.geometry
  throw new Error(`cannot restore ambulance motion: target ${object.id} has no point geometry`)
}

const shouldRestoreRoute = (object: OperationalObject): boolean =>
  object.kind === 'mobile_entity'
  && (
    object.operational.status === 'assigned'
    || object.operational.status === 'en_route'
    || object.operational.status === 'transporting'
  )
  && object.tasking?.currentTaskId !== undefined
  && object.spatial.position?.point !== undefined
  && object.spatial.route?.planned === undefined

const restoreMissingRuntimeRoutes = async (
  objects: ReadonlyArray<OperationalObject>,
  routing: RoutingAdapter,
): Promise<ReadonlyArray<OperationalObject>> => {
  const objectMap = new Map(objects.map(object => [object.id, object]))
  const restored: OperationalObject[] = []
  for (const object of objects) {
    if (!shouldRestoreRoute(object)) {
      restored.push(object)
      continue
    }
    const targetId = object.tasking?.currentTaskId
    const from = object.spatial.position?.point
    if (!targetId || !from) {
      restored.push(object)
      continue
    }
    const target = objectMap.get(targetId)
    if (!target) {
      restored.push(object)
      continue
    }
    const route = await routing.route({
      from,
      to: pointForTarget(target),
    })
    restored.push({
      ...object,
      spatial: {
        ...object.spatial,
        route: {
          planned: route.geometry,
          etaSeconds: route.durationSeconds,
          source: 'simulator',
        },
      },
    })
  }
  return restored
}

export const createLocalAmbulancePackRuntimeAdapter = (adapterConfig: {
  readonly routing: RoutingAdapter
}): PackRuntimeAdapter => ({
  id: ambulanceSimRuntimeId,
  version: '1.0.0',
  packId: ambulancePackId,
  clock: 'simulation',
  capabilities: [
    defineSimulationCommandCapability({ id: createIncidentCommandKind, title: 'Create incident', description: 'Creates an incident using the same definition and constructor as Scenario authoring. Its explicit id can be targeted by later actions.', input: createIncidentPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [], payload: createIncidentPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: setIncidentVictimsCommandKind, title: 'Set incident victim count', description: 'Changes only the victim count on the current incident; preserves live assignments, progress and other state.', input: setIncidentVictimsPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [setIncidentVictimsPayloadSchema.parse(input).objectId], payload: setIncidentVictimsPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: assignToIncidentCommandKind, title: 'Assign ambulance to incident', description: 'Assigns one ambulance to one incident and plans its response route.', input: assignToIncidentPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [assignToIncidentPayloadSchema.parse(input).ambulanceId], payload: assignToIncidentPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: cancelDestinationCommandKind, title: 'Cancel ambulance destination', description: 'Cancels the active destination and route for one ambulance.', input: cancelDestinationPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [cancelDestinationPayloadSchema.parse(input).ambulanceId], payload: cancelDestinationPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: createObjectCommandKind, title: 'Create ambulance asset', description: 'Creates an ambulance, hospital, or incident at an explicit map point.', input: createObjectPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [], payload: createObjectPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: setDestinationCommandKind, title: 'Set ambulance destination', description: 'Sets one ambulance destination and plans a route to it.', input: setDestinationPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [setDestinationPayloadSchema.parse(input).ambulanceId], payload: setDestinationPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({
      id: setRoadWeatherPolicyCapability,
      title: 'Set road-weather policy',
      description:
        'Enable/disable or configure the mobility response to local ground wetness, ice, snow and visibility. Does not modify Weather or re-route vehicles.',
      input: roadWeatherPolicySchema,
      output: commandResultSchema,
      idempotent: true,
      schedulable: true,
      buildCommand: (input) => ({ targetObjectIds: [], payload: roadWeatherPolicySchema.parse(input) }),
    }),
    defineSimulationQueryCapability({
      id: 'world.ambulance.road-weather-policy',
      title: 'Inspect road-weather policy',
      description:
        'Current simulated speed policy. Local weather samples, not a physical tire/friction model. Factors apply at the current vehicle position, not along the entire planned route.',
      input: z.object({}).strict(),
      output: roadWeatherPolicySchema,
    }),
    ...ambulanceQueryCapabilities,
  ],
  requiredQueries: runtimeConfig => ambulancePackConfigSchema.parse(runtimeConfig).roadWeather.enabled ? [roadWeatherCapability] : [],
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const settings = ambulancePackConfigSchema.parse(config.scenario.runtimeConfig)
    const savedPolicy = await config.runtimeStateStore?.load()
    let policy =
      savedPolicy === null || savedPolicy === undefined
        ? settings.roadWeather
        : roadWeatherPolicySchema.parse(savedPolicy)
    const assertProvider = (enabled: boolean): void => {
      if (enabled && !config.queries?.has(roadWeatherCapability))
        throw new Error('Ambulance road-weather policy requires an active Weather sample-points provider')
    }
    assertProvider(policy.enabled)
    const objects = await restoreMissingRuntimeRoutes(initialObjectsFor(config), adapterConfig.routing)
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId,
      routing: adapterConfig.routing,
      objects,
    })
    const handlers = new Set<PackRuntimeEventHandler>()
    const recordingPlan = config.recording === undefined ? null : createAmbulanceRecordingPlan(config.recording)
    let closed = false
    let queue: Promise<unknown> = Promise.resolve()
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const next = queue.then(work, work)
      queue = next.catch(() => {})
      return next
    }
    let health: PackRuntimeHealth = {
      runtimeId: ambulanceSimRuntimeId,
      state: 'ready',
      failureCount: 0,
      lastSuccessfulInteractionAt: nowIso(),
    }
    const refreshRoadWeather = async (): Promise<ReadonlyArray<PackRuntimeEvent>> => {
      const vehicles = engine
        .snapshot()
        .objects.filter(
          (object) =>
            object.kind === 'mobile_entity' && object.spatial.route?.planned && object.spatial.position?.point,
        )
      const changes: PackRuntimeEvent[] = []
      for (let offset = 0; offset < vehicles.length; offset += 512) {
        const batch = vehicles.slice(offset, offset + 512)
        const samples = policy.enabled
          ? roadWeatherSamplesSchema.parse(
              await config.queries!.invoke({
                capabilityId: roadWeatherCapability,
                input: { points: batch.map((object) => object.spatial.position!.point) },
              }),
            )
          : []
        if (policy.enabled && samples.length !== batch.length)
          throw new Error('Weather sample count does not match requested vehicles')
        batch.forEach((object, index) => {
          const sampled = samples[index]
          if (sampled && JSON.stringify(sampled.point) !== JSON.stringify(object.spatial.position!.point))
            throw new Error('Weather sample position mismatch')
          const event = engine.setRoadWeatherImpact(
            object.id,
            sampled ? roadWeatherImpact(policy, sampled.sample) : undefined,
          )
          if (event) changes.push(event)
        })
      }
      return changes
    }
    let elapsedMs = 0
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    let clock: SimulationClockState = {
      currentTime: config.scenario.world.startsAt,
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    clock = config.runClock?.read() ?? clock
    const localClock = config.runClock ? null : createSimulationClock(clock)
    const runClock = config.runClock ?? localClock!
    let clockInitialized = false
    let lastSimulationMs = Date.parse(clock.currentTime)
    const advance = async (): Promise<void> => {
        if (clock.paused || closed) return
        const roadEvents = await refreshRoadWeather()
        const simulationMs = Date.parse(runClock.read().currentTime)
        const tickMs = Math.max(0, simulationMs - lastSimulationMs)
        lastSimulationMs = simulationMs
        if (tickMs <= 0) return
        elapsedMs = simulationMs - Date.parse(config.scenario.world.startsAt)
        const events = engine.tick(tickMs)
        const recording = recordingPlan !== null && elapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = elapsedMs + recordingPlan.intervalMs
            const observedAt = nowIso()
            return recordingPlan.sample({
              objects: engine.snapshot().objects,
              observedAt,
              simulationTime: new Date(simulationMs).toISOString() as IsoTimestamp,
              elapsedMs,
            })
          })()
        : undefined
        emit(handlers, [...roadEvents, ...events], recording)
        health = { ...health, state: 'ready', lastSuccessfulInteractionAt: nowIso() }
    }
    let tickPending = false
    const interval = setInterval(() => {
      if (closed || tickPending) return
      tickPending = true
      void serialize(advance)
        .catch((error) => {
          health = {
            ...health,
            state: 'degraded',
            failureCount: health.failureCount + 1,
            lastFailure: {
              at: nowIso(),
              operation: 'road-weather/tick',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        })
        .finally(() => {
          tickPending = false
        })
    }, 1000)

    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      if (command.kind === setRoadWeatherPolicyCapability) {
        const at = nowIso()
        try {
          const candidate = roadWeatherPolicySchema.parse(command.payload)
          assertProvider(candidate.enabled)
          await config.runtimeStateStore?.save(candidate)
          policy = candidate
          emit(handlers, await refreshRoadWeather())
          return { ok: true, commandId: command.id, acceptedAt: at }
        } catch (error) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: at,
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      }
      const result = await engine.handleCommand(command)
      if (result.ok) {
        await refreshRoadWeather()
        const snapshot = engine.snapshot()
        const objectEvents: PackRuntimeEvent[] = snapshot.objects.map(object => ({
          type: 'object.upserted',
          object,
          at: snapshot.capturedAt,
          history: 'record',
          provenance: object.provenance,
        }))
        const routeSignals: PackRuntimeEvent[] = snapshot.objects
          .filter(object => object.spatial.route?.planned && command.targetObjectIds.includes(object.id))
          .map(object => {
            const signal = interactionSignalSchema.parse({
              id: `signal:${randomUUID()}` as SignalId,
              simulationRunId: command.simulationRunId,
              at: snapshot.capturedAt,
              source: { kind: 'object', id: object.id, runtimeId: ambulanceSimRuntimeId },
              targets: [{ kind: 'object', id: object.id }],
              type: assetRoutePlannedSignalType,
              severity: 'notice',
              payload: { objectId: object.id },
              causationId: command.id,
            }) as InteractionSignal
            return {
              type: 'interaction.signal',
              signal,
              at: snapshot.capturedAt,
              provenance: {
                source: 'simulator',
                adapterId: ambulanceSimAdapterId,
                externalId: object.id,
                causedByCommandId: command.id,
              },
            }
          })
        emit(handlers, [...objectEvents, ...routeSignals])
      }
      return result
    }

    return {
      getSnapshot: async () => engine.snapshot(),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      invokeQuery: async (request: PackRuntimeQuery): Promise<unknown> =>
        request.capabilityId === 'world.ambulance.road-weather-policy'
          ? structuredClone(policy)
          : answerAmbulanceQuery({
          request,
          objects: engine.snapshot().objects,
          at: nowIso(),
        }),
      observeInitialSnapshot: async () => {
        await refreshRoadWeather()
      },
      observeCommittedEvents: (events) =>
        serialize(async () => {
          engine.observeCommittedEvents(events.filter(event =>
          event.type === 'object.deleted'
          || (event.type === 'object.upserted' && event.object.packId === ambulancePackId)
        ))
          if (
            events.some(
              (event) =>
                event.type === 'object.deleted' ||
                (event.type === 'object.upserted' && event.object.packId !== ambulancePackId),
            )
          )
            emit(handlers, await refreshRoadWeather())
        }),
      setClock: (nextClock) =>
        serialize(async () => {
        if (clockInitialized) await advance()
        clockInitialized = true
        clock = nextClock
        localClock?.set(nextClock)
        lastSimulationMs = Date.parse(runClock.read().currentTime)
      }),
      health: () => [health],
      sendCommand: (command) => serialize(() => sendCommand(command)),
      close: async (): Promise<void> => {
        closed = true
        clearInterval(interval)
        await queue
        handlers.clear()
        await config.runtimeStateStore?.save(policy)
      },
    }
  },
})

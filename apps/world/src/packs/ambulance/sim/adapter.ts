import { randomUUID } from 'node:crypto'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEvent, PackRuntimeEventHandler, PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { commandResultSchema } from '../../../core/model/index.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import type { CommandEnvelope, CommandResult, GeoJsonPoint, InteractionSignal, IsoTimestamp, OperationalObject, PackRuntimeRecordingBatch, SignalId, SimulationClockState } from '../../../core/model/index.ts'
import { assetRoutePlannedSignalType, interactionSignalSchema, nowIso } from '../../../core/model/index.ts'
import { ambulancePackDataSchema, ambulancePackId, hospitalPackDataSchema, incidentPackDataSchema } from '../model.ts'
import { createAmbulanceSimEngine } from './engine.ts'
import { ambulanceSimAdapterId, ambulanceSimRuntimeId } from './constants.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import {
  assignToIncidentCommandKind,
  assignToIncidentPayloadSchema,
  cancelDestinationCommandKind,
  cancelDestinationPayloadSchema,
  createObjectCommandKind,
  createObjectPayloadSchema,
  setDestinationCommandKind,
  setDestinationPayloadSchema,
} from '../commands.ts'
import { ambulanceQueryCapabilities, answerAmbulanceQuery } from '../query.ts'
import { createAmbulanceRecordingPlan } from '../recording.ts'

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
    defineSimulationCommandCapability({ id: assignToIncidentCommandKind, title: 'Assign ambulance to incident', description: 'Assigns one ambulance to one incident and plans its response route.', input: assignToIncidentPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [assignToIncidentPayloadSchema.parse(input).ambulanceId], payload: assignToIncidentPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: cancelDestinationCommandKind, title: 'Cancel ambulance destination', description: 'Cancels the active destination and route for one ambulance.', input: cancelDestinationPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [cancelDestinationPayloadSchema.parse(input).ambulanceId], payload: cancelDestinationPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: createObjectCommandKind, title: 'Create ambulance asset', description: 'Creates an ambulance, hospital, or incident at an explicit map point.', input: createObjectPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [], payload: createObjectPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: setDestinationCommandKind, title: 'Set ambulance destination', description: 'Sets one ambulance destination and plans a route to it.', input: setDestinationPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [setDestinationPayloadSchema.parse(input).ambulanceId], payload: setDestinationPayloadSchema.parse(input) }) }),
    ...ambulanceQueryCapabilities,
  ],
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const objects = await restoreMissingRuntimeRoutes(initialObjectsFor(config), adapterConfig.routing)
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId,
      routing: adapterConfig.routing,
      objects,
    })
    const handlers = new Set<PackRuntimeEventHandler>()
    const recordingPlan = config.recording === undefined ? null : createAmbulanceRecordingPlan(config.recording)
    let elapsedMs = 0
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    let clock: SimulationClockState = {
      currentTime: config.scenario.world.startsAt,
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    let simulationTimeOffsetMs = Date.parse(clock.currentTime)
    const interval = setInterval(() => {
      if (clock.paused) return
      const tickMs = Math.round(1_000 * clock.speed)
      if (tickMs <= 0) return
      elapsedMs += tickMs
      const events = engine.tick(tickMs)
      const recording = recordingPlan !== null && elapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = elapsedMs + recordingPlan.intervalMs
            const observedAt = nowIso()
            return recordingPlan.sample({
              objects: engine.snapshot().objects,
              observedAt,
              simulationTime: new Date(simulationTimeOffsetMs + elapsedMs).toISOString() as IsoTimestamp,
              elapsedMs,
            })
          })()
        : undefined
      emit(handlers, events, recording)
    }, 1000)

    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const result = await engine.handleCommand(command)
      if (result.ok) {
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
        answerAmbulanceQuery({
          request,
          objects: engine.snapshot().objects,
          at: nowIso(),
        }),
      observeCommittedEvents: async (events): Promise<void> => {
        engine.observeCommittedEvents(events.filter(event =>
          event.type === 'object.deleted'
          || (event.type === 'object.upserted' && event.object.packId === ambulancePackId)
        ))
      },
      setClock: async (nextClock): Promise<void> => {
        clock = nextClock
        simulationTimeOffsetMs = Date.parse(nextClock.currentTime) - elapsedMs
      },
      sendCommand,
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})

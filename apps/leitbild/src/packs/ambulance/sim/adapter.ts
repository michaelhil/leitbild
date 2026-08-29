import { randomUUID } from 'node:crypto'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEvent, PackRuntimeEventHandler } from '../../../simulation/protocol.ts'
import type { CommandEnvelope, CommandResult, GeoJsonPoint, InteractionSignal, OperationalObject, SignalId } from '../../../core/model/index.ts'
import { assetRoutePlannedSignalType, interactionSignalSchema, nowIso } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { ambulancePackDataSchema, ambulancePackId, hospitalPackDataSchema, incidentPackDataSchema } from '../model.ts'
import { createAmbulanceSimEngine } from './engine.ts'
import { ambulanceSimAdapterId, ambulanceSimRuntimeId } from './constants.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import {
  assignToIncidentCommandKind,
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../commands.ts'
import { ambulanceQueryKinds, answerAmbulanceQuery } from '../query.ts'

const emit = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
): void => {
  const firstEvent = events[0]
  if (!firstEvent) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      emittedAt: firstEvent.at,
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
  const objects = config.initialObjects ?? config.scenario?.initialObjects
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
  acceptedCommandKinds: [
    assignToIncidentCommandKind,
    cancelDestinationCommandKind,
    createObjectCommandKind,
    setDestinationCommandKind,
  ],
  queryKinds: ambulanceQueryKinds,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const objects = await restoreMissingRuntimeRoutes(initialObjectsFor(config), adapterConfig.routing)
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId,
      routing: adapterConfig.routing,
      objects,
    })
    const handlers = new Set<PackRuntimeEventHandler>()
    let clock = {
      currentTime: nowIso(),
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    const interval = setInterval(() => {
      if (clock.paused) return
      const events = engine.tick(Math.round(1000 * clock.speed))
      emit(handlers, events)
    }, 1000)

    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const result = await engine.handleCommand(command)
      if (result.ok) {
        const snapshot = engine.snapshot()
        const objectEvents: PackRuntimeEvent[] = snapshot.objects.map(object => ({
          type: 'object.upserted',
          object,
          at: snapshot.capturedAt,
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
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> =>
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
      },
      sendCommand,
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})

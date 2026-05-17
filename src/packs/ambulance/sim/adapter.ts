import { randomUUID } from 'node:crypto'
import type { SimulationAdapter, SimulationConnection, SimulationConnectionConfig, SimulationEvent, SimulationEventHandler } from '../../../simulation/protocol.ts'
import type { CommandEnvelope, CommandResult, InteractionSignal, OperationalObject, SignalId } from '../../../core/model/index.ts'
import { assetRoutePlannedSignalType, interactionSignalSchema } from '../../../core/model/index.ts'
import { ambulanceDomainDataSchema, ambulanceDomainId, hospitalDomainDataSchema, incidentDomainDataSchema } from '../model.ts'
import { createAmbulanceSimEngine } from './engine.ts'
import { ambulanceSimAdapterId, ambulanceSimProviderId } from './constants.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import {
  assignToIncidentCommandKind,
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../commands.ts'

const emit = (
  handlers: ReadonlySet<SimulationEventHandler>,
  events: ReadonlyArray<SimulationEvent>,
): void => {
  const firstEvent = events[0]
  if (!firstEvent) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      emittedAt: firstEvent.at,
      providerId: ambulanceSimProviderId,
    })
  }
}

const validateAmbulanceProviderObject = (object: OperationalObject): OperationalObject => {
  if (object.kind === 'mobile_entity') {
    const parsed = ambulanceDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success) throw new Error(`invalid ambulance object domain data for ${object.id}: ${parsed.error.message}`)
    return { ...object, domainData: parsed.data }
  }
  if (object.kind === 'facility') {
    const parsed = hospitalDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success) throw new Error(`invalid hospital object domain data for ${object.id}: ${parsed.error.message}`)
    return { ...object, domainData: parsed.data }
  }
  if (object.kind === 'incident') {
    const parsed = incidentDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success) throw new Error(`invalid incident object domain data for ${object.id}: ${parsed.error.message}`)
    return { ...object, domainData: parsed.data }
  }
  throw new Error(`unsupported ambulance provider object kind for ${object.id}: ${object.kind}`)
}

const initialObjectsFor = (config: SimulationConnectionConfig): ReadonlyArray<OperationalObject> => {
  const objects = config.initialObjects ?? config.scenario?.initialObjects
  if (!objects) throw new Error(`ambulance provider requires scenario or restored objects for control instance ${config.controlInstanceId}`)
  return objects.map(validateAmbulanceProviderObject)
}

export const createLocalAmbulanceSimulationAdapter = (adapterConfig: {
  readonly routing: RoutingAdapter
}): SimulationAdapter => ({
  id: ambulanceSimProviderId,
  domain: ambulanceDomainId,
  acceptedCommandKinds: [
    assignToIncidentCommandKind,
    cancelDestinationCommandKind,
    createObjectCommandKind,
    setDestinationCommandKind,
  ],
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId: config.controlInstanceId,
      routing: adapterConfig.routing,
      objects: initialObjectsFor(config),
    })
    const handlers = new Set<SimulationEventHandler>()
    const interval = setInterval(() => {
      const events = engine.tick(1000)
      emit(handlers, events)
    }, 1000)

    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const result = await engine.handleCommand(command)
      if (result.ok) {
        const snapshot = engine.snapshot()
        const objectEvents: SimulationEvent[] = snapshot.objects.map(object => ({
          type: 'object.upserted',
          object,
          at: snapshot.capturedAt,
          provenance: object.provenance,
        }))
        const routeSignals: SimulationEvent[] = snapshot.objects
          .filter(object => object.spatial.route?.planned && command.targetObjectIds.includes(object.id))
          .map(object => {
            const signal = interactionSignalSchema.parse({
              id: `signal:${randomUUID()}` as SignalId,
              controlInstanceId: command.controlInstanceId,
              at: snapshot.capturedAt,
              source: { kind: 'object', id: object.id, providerId: ambulanceSimProviderId },
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
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      observeCommittedEvents: async (events): Promise<void> => {
        engine.observeCommittedEvents(events)
      },
      sendCommand,
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})

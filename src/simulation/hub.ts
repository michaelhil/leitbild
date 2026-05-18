import type { CommandEnvelope, CommandResult, DomainEvent, OperationalObject } from '../core/model/index.ts'
import { nowIso } from '../core/model/index.ts'
import type { SimulationAdapter, SimulationConnection, SimulationConnectionConfig, SimulationEmission, SimulationEventHandler, SimulationScenarioRuntimeConfig, SimulationSnapshot } from './protocol.ts'

const duplicateObjectIds = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const object of objects) {
    if (seen.has(object.id)) duplicates.add(object.id)
    seen.add(object.id)
  }
  return [...duplicates].sort()
}

const restoredObjectsFor = (
  adapter: SimulationAdapter,
  objects: ReadonlyArray<OperationalObject> | undefined,
): ReadonlyArray<OperationalObject> | undefined => {
  if (!objects) return undefined
  return objects.filter(object => object.domain === adapter.domain)
}

const scenarioFor = (
  adapter: SimulationAdapter,
  scenario: SimulationConnectionConfig['scenario'],
): SimulationScenarioRuntimeConfig | undefined => {
  if (!scenario) return undefined
  return {
    scenarioId: scenario.scenarioId,
    providerIds: scenario.providerIds,
    world: scenario.world,
    initialObjects: scenario.initialObjects.filter(object => object.domain === adapter.domain),
    providerConfigs: scenario.providerConfigs,
    providerConfig: scenario.providerConfigs[adapter.id] ?? {},
  }
}

export const createSimulationHub = (adapters: ReadonlyArray<SimulationAdapter>): SimulationAdapter => {
  if (adapters.length === 0) throw new Error('SimulationHub requires at least one simulation adapter')
  const adapterIds = new Set<string>()
  for (const adapter of adapters) {
    if (adapterIds.has(adapter.id)) throw new Error(`duplicate simulation adapter id: ${adapter.id}`)
    adapterIds.add(adapter.id)
  }

  return {
    id: 'simulation-hub',
    domain: 'simulation-hub',
    acceptedCommandKinds: adapters.flatMap(adapter => adapter.acceptedCommandKinds),
    connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
      const missingProviderIds = config.scenario?.providerIds.filter(providerId => !adapterIds.has(providerId)) ?? []
      if (missingProviderIds.length > 0) throw new Error(`missing simulation providers: ${missingProviderIds.join(', ')}`)
      const connections = await Promise.all(adapters.map(async adapter => {
        const initialObjects = restoredObjectsFor(adapter, config.initialObjects)
        const scenario = scenarioFor(adapter, config.scenario)
        return {
          adapter,
          connection: await adapter.connect({
            controlInstanceId: config.controlInstanceId,
            ...(scenario === undefined ? {} : { scenario }),
            ...(initialObjects === undefined ? {} : { initialObjects }),
          }),
        }
      }))
      const handlers = new Set<SimulationEventHandler>()
      const unsubscribes = connections.map(({ connection }) => connection.subscribe((emission: SimulationEmission) => {
        for (const handler of handlers) handler(emission)
      }))

      const getSnapshot = async (): Promise<SimulationSnapshot> => {
        const snapshots = await Promise.all(connections.map(({ connection }) => connection.getSnapshot()))
        const objects = snapshots.flatMap(snapshot => snapshot.objects)
        const duplicates = duplicateObjectIds(objects)
        if (duplicates.length > 0) {
          throw new Error(`duplicate simulation object ids from providers: ${duplicates.join(', ')}`)
        }
        return {
          controlInstanceId: config.controlInstanceId,
          objects,
          capturedAt: nowIso(),
        }
      }

      const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
        const target = connections.find(({ adapter }) => adapter.acceptedCommandKinds.includes(command.kind))
        if (!target) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: nowIso(),
            reason: `no simulation provider accepts command kind: ${command.kind}`,
          }
        }
        return target.connection.sendCommand(command)
      }

      return {
        getSnapshot,
        subscribe: (handler: SimulationEventHandler): (() => void) => {
          handlers.add(handler)
          return () => {
            handlers.delete(handler)
          }
        },
        sendCommand,
        observeCommittedEvents: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
          await Promise.all(connections.map(({ connection }) => connection.observeCommittedEvents(events)))
        },
        setClock: async (clock): Promise<void> => {
          await Promise.all(connections.map(({ connection }) => connection.setClock(clock)))
        },
        close: async (): Promise<void> => {
          for (const unsubscribe of unsubscribes) unsubscribe()
          handlers.clear()
          await Promise.all(connections.map(({ connection }) => connection.close()))
        },
      }
    },
  }
}

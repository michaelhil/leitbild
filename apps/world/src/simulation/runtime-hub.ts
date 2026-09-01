import type { CommandEnvelope, CommandResult, SimulationRunEvent, OperationalObject } from '../core/model/index.ts'
import { nowIso } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../core/packs/protocol.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEmission, PackRuntimeEventHandler, PackRuntimeRealtimeInput, PackScenarioRuntimeConfig, PackRuntimeSnapshot } from './protocol.ts'

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
  adapter: PackRuntimeAdapter,
  objects: ReadonlyArray<OperationalObject> | undefined,
): ReadonlyArray<OperationalObject> | undefined => {
  if (!objects) return undefined
  return objects.filter(object => object.packId === adapter.packId)
}

const scenarioFor = (
  adapter: PackRuntimeAdapter,
  scenario: PackRuntimeConnectionConfig['scenario'],
): PackScenarioRuntimeConfig | undefined => {
  if (!scenario) return undefined
  return {
    scenarioId: scenario.scenarioId,
    runtimeIds: scenario.runtimeIds,
    world: scenario.world,
    initialObjects: scenario.initialObjects.filter(object => object.packId === adapter.packId),
    runtimeConfig: scenario.runtimeConfigByRuntimeId?.[adapter.id] ?? scenario.runtimeConfig,
  }
}

export const createRuntimeHub = (adapters: ReadonlyArray<PackRuntimeAdapter>): PackRuntimeAdapter => {
  if (adapters.length === 0) throw new Error('RuntimeHub requires at least one pack runtime adapter')
  const adapterIds = new Set<string>()
  for (const adapter of adapters) {
    if (adapterIds.has(adapter.id)) throw new Error(`duplicate pack runtime adapter id: ${adapter.id}`)
    adapterIds.add(adapter.id)
  }

  return {
    id: 'runtime-hub',
    version: '1.0.0',
    packId: 'runtime-hub',
    acceptedCommandKinds: adapters.flatMap(adapter => adapter.acceptedCommandKinds),
    acceptedRealtimeInputTypes: adapters.flatMap(adapter => adapter.acceptedRealtimeInputTypes ?? []),
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      const missingRuntimeIds = config.scenario?.runtimeIds.filter(runtimeId => !adapterIds.has(runtimeId)) ?? []
      if (missingRuntimeIds.length > 0) throw new Error(`missing pack runtimes: ${missingRuntimeIds.join(', ')}`)
      const activeRuntimeIds = config.scenario ? new Set(config.scenario.runtimeIds) : null
      const activeAdapters = activeRuntimeIds
        ? adapters.filter(adapter => activeRuntimeIds.has(adapter.id))
        : adapters
      const connections = await Promise.all(activeAdapters.map(async adapter => {
        const initialObjects = restoredObjectsFor(adapter, config.initialObjects)
        const scenario = scenarioFor(adapter, config.scenario)
        return {
          adapter,
          connection: await adapter.connect({
            simulationRunId: config.simulationRunId,
            ...(scenario === undefined ? {} : { scenario }),
            ...(initialObjects === undefined ? {} : { initialObjects }),
            ...(config.runtimeStateStores?.[adapter.id] === undefined
              ? {}
              : { runtimeStateStore: config.runtimeStateStores[adapter.id] }),
          }),
        }
      }))
      const handlers = new Set<PackRuntimeEventHandler>()
      const unsubscribes = connections.map(({ connection }) => connection.subscribe((emission: PackRuntimeEmission) => {
        for (const handler of handlers) handler(emission)
      }))

      const getSnapshot = async (): Promise<PackRuntimeSnapshot> => {
        const snapshots = await Promise.all(connections.map(({ connection }) => connection.getSnapshot()))
        const objects = snapshots.flatMap(snapshot => snapshot.objects)
        const duplicates = duplicateObjectIds(objects)
        if (duplicates.length > 0) {
          throw new Error(`duplicate runtime object ids from runtimes: ${duplicates.join(', ')}`)
        }
        return {
          simulationRunId: config.simulationRunId,
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
            reason: `no pack runtime accepts command kind: ${command.kind}`,
          }
        }
        return target.connection.sendCommand(command)
      }

      const receiveRealtimeInput = async (input: PackRuntimeRealtimeInput): Promise<void> => {
        const target = connections.find(({ adapter }) => adapter.acceptedRealtimeInputTypes?.includes(input.type) ?? false)
        if (!target) throw new Error(`no pack runtime accepts realtime input type: ${input.type}`)
        if (!target.connection.receiveRealtimeInput) throw new Error(`pack runtime cannot receive realtime input type: ${input.type}`)
        await target.connection.receiveRealtimeInput(input)
      }

      const commandEventPersistence = (command: CommandEnvelope) => {
        const target = connections.find(({ adapter }) => adapter.acceptedCommandKinds.includes(command.kind))
        return target?.adapter.commandEventPersistence?.[command.kind] ?? 'durable'
      }

      const query = async (request: PackQueryRequest): Promise<PackQueryResponse> => {
        const target = connections.find(({ adapter }) => adapter.packId === request.packId)
        if (!target) {
          return {
            ok: false,
            packId: request.packId,
            kind: request.kind,
            reason: `no pack runtime is active for pack: ${request.packId}`,
            generatedAt: nowIso(),
          }
        }
        return await target.connection.query(request)
      }

      return {
        getSnapshot,
        subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
          handlers.add(handler)
          return () => {
            handlers.delete(handler)
          }
        },
        sendCommand,
        receiveRealtimeInput,
        commandEventPersistence,
        query,
        observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
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

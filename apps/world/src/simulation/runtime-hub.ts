import type { CommandEnvelope, CommandResult, SimulationRunEvent, OperationalObject } from '../core/model/index.ts'
import { nowIso } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../core/packs/protocol.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEmission, PackRuntimeEventHandler, PackRuntimeRealtimeInput, PackScenarioRuntimeConfig, PackRuntimeSnapshot } from './protocol.ts'
import { definePackRuntimeOperations, operationIds } from './operations.ts'

const duplicateObjectIds = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const object of objects) {
    if (seen.has(object.id)) duplicates.add(object.id)
    seen.add(object.id)
  }
  return [...duplicates].sort()
}

const assertUniqueRoutes = (
  adapters: ReadonlyArray<PackRuntimeAdapter>,
  routesFor: (adapter: PackRuntimeAdapter) => ReadonlyArray<string>,
  routeType: string,
): void => {
  const owners = new Map<string, string>()
  for (const adapter of adapters) {
    for (const route of routesFor(adapter)) {
      const owner = owners.get(route)
      if (owner) throw new Error(`duplicate ${routeType} route ${route}: ${owner}, ${adapter.id}`)
      owners.set(route, adapter.id)
    }
  }
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
    clock: adapters.some(adapter => adapter.clock === 'live')
      ? 'live'
      : adapters.some(adapter => adapter.clock === 'simulation') ? 'simulation' : 'none',
    operations: definePackRuntimeOperations({
      commands: adapters.flatMap(adapter => operationIds(adapter.operations, 'command')),
      queries: adapters.flatMap(adapter => operationIds(adapter.operations, 'query')),
      realtimeInputs: adapters.flatMap(adapter => operationIds(adapter.operations, 'realtime-input')),
    }),
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      const missingRuntimeIds = config.scenario?.runtimeIds.filter(runtimeId => !adapterIds.has(runtimeId)) ?? []
      if (missingRuntimeIds.length > 0) throw new Error(`missing pack runtimes: ${missingRuntimeIds.join(', ')}`)
      const activeRuntimeIds = config.scenario ? new Set(config.scenario.runtimeIds) : null
      const activeAdapters = activeRuntimeIds
        ? adapters.filter(adapter => activeRuntimeIds.has(adapter.id))
        : adapters
      assertUniqueRoutes(activeAdapters, adapter => operationIds(adapter.operations, 'command'), 'command')
      assertUniqueRoutes(activeAdapters, adapter => operationIds(adapter.operations, 'realtime-input'), 'realtime input')
      assertUniqueRoutes(
        activeAdapters,
        adapter => operationIds(adapter.operations, 'query').map(route => `${adapter.packId}:${route}`),
        'Pack query',
      )
      const connectionResults = await Promise.allSettled(activeAdapters.map(async adapter => {
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
            ...(config.recordingByRuntimeId?.[adapter.id] === undefined
              ? {}
              : { recording: config.recordingByRuntimeId[adapter.id] }),
          }),
        }
      }))
      const failedConnection = connectionResults.find(result => result.status === 'rejected')
      if (failedConnection) {
        await Promise.allSettled(connectionResults.flatMap(result =>
          result.status === 'fulfilled' ? [result.value.connection.close()] : []))
        throw failedConnection.reason
      }
      const connections = connectionResults.map(result => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      const commandTargets = new Map(connections.flatMap(target =>
        operationIds(target.adapter.operations, 'command').map(route => [route, target] as const)))
      const realtimeInputTargets = new Map(connections.flatMap(target =>
        operationIds(target.adapter.operations, 'realtime-input').map(route => [route, target] as const)))
      const queryTargets = new Map(connections.flatMap(target =>
        operationIds(target.adapter.operations, 'query').map(route => [`${target.adapter.packId}:${route}`, target] as const)))
      const activePackIds = new Set(connections.map(({ adapter }) => adapter.packId))
      const handlers = new Set<PackRuntimeEventHandler>()
      const unsubscribes = connections.map(({ adapter, connection }) => connection.subscribe((emission: PackRuntimeEmission) => {
        if (emission.runtimeId !== adapter.id) {
          console.error(`dropped Pack Runtime emission from ${adapter.id}: claimed runtime ${emission.runtimeId}`)
          return
        }
        const foreignObject = emission.events.find(event => event.type === 'object.upserted' && event.object.packId !== adapter.packId)
        if (foreignObject?.type === 'object.upserted') {
          console.error(`dropped Pack Runtime emission from ${adapter.id}: object ${foreignObject.object.id} belongs to Pack ${foreignObject.object.packId}`)
          return
        }
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
        const target = commandTargets.get(command.kind)
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
        const target = realtimeInputTargets.get(input.type)
        if (!target) throw new Error(`no pack runtime accepts realtime input type: ${input.type}`)
        if (!target.connection.receiveRealtimeInput) throw new Error(`pack runtime cannot receive realtime input type: ${input.type}`)
        await target.connection.receiveRealtimeInput(input)
      }

      const commandEventHistory = (command: CommandEnvelope) => {
        const target = commandTargets.get(command.kind)
        return target?.adapter.commandEventHistory?.[command.kind] ?? 'record'
      }

      const query = async (request: PackQueryRequest): Promise<PackQueryResponse> => {
        const target = queryTargets.get(`${request.packId}:${request.kind}`)
        if (!target) {
          const packIsActive = activePackIds.has(request.packId)
          return {
            ok: false,
            packId: request.packId,
            kind: request.kind,
            reason: packIsActive
              ? `active Pack Runtime does not declare query kind: ${request.kind}`
              : `no Pack Runtime is active for Pack: ${request.packId}`,
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
        commandEventHistory,
        query,
        observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
          const observations = await Promise.allSettled(connections.map(({ connection }) => connection.observeCommittedEvents(events)))
          observations.forEach((result, index) => {
            if (result.status === 'rejected') {
              console.error(`pack runtime ${connections[index]!.adapter.id} failed to observe committed events:`, result.reason)
            }
          })
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

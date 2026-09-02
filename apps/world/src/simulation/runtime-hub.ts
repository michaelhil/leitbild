import type { CommandEnvelope, CommandResult, SimulationRunEvent, OperationalObject } from '../core/model/index.ts'
import { nowIso } from '../core/model/index.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEmission, PackRuntimeEventHandler, PackRuntimeHealth, PackRuntimeQuery, PackRuntimeRealtimeInput, PackScenarioRuntimeConfig, PackRuntimeSnapshot } from './protocol.ts'
import { capabilityIds } from './capabilities.ts'

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
): PackScenarioRuntimeConfig => {
  return {
    scenarioId: scenario.scenarioId,
    runtimeIds: scenario.runtimeIds,
    world: scenario.world,
    initialObjects: scenario.initialObjects.filter(object => object.packId === adapter.packId),
    connections: scenario.connections,
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
    capabilities: adapters.flatMap(adapter => adapter.capabilities),
    realtimeInputTypes: adapters.flatMap(adapter => adapter.realtimeInputTypes ?? []),
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      const missingRuntimeIds = config.scenario.runtimeIds.filter(runtimeId => !adapterIds.has(runtimeId))
      if (missingRuntimeIds.length > 0) throw new Error(`missing pack runtimes: ${missingRuntimeIds.join(', ')}`)
      const activeRuntimeIds = new Set(config.scenario.runtimeIds)
      const activeAdapters = adapters.filter(adapter => activeRuntimeIds.has(adapter.id))
      assertUniqueRoutes(activeAdapters, adapter => capabilityIds(adapter.capabilities, 'command'), 'command')
      assertUniqueRoutes(activeAdapters, adapter => adapter.realtimeInputTypes ?? [], 'realtime input')
      assertUniqueRoutes(activeAdapters, adapter => capabilityIds(adapter.capabilities, 'query'), 'query')
      const connectionResults = await Promise.allSettled(activeAdapters.map(async adapter => {
        const initialObjects = restoredObjectsFor(adapter, config.initialObjects)
        const scenario = scenarioFor(adapter, config.scenario)
        return {
          adapter,
          connection: await adapter.connect({
            simulationRunId: config.simulationRunId,
            scenario,
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
      const healthByRuntime = new Map<string, PackRuntimeHealth>(connections.map(({ adapter }) => [adapter.id, {
        runtimeId: adapter.id,
        state: 'ready',
        failureCount: 0,
        lastSuccessfulInteractionAt: nowIso(),
      }]))
      const markHealthy = (runtimeId: string): void => {
        const current = healthByRuntime.get(runtimeId)
        if (!current) return
        healthByRuntime.set(runtimeId, {
          ...current,
          state: 'ready',
          lastSuccessfulInteractionAt: nowIso(),
        })
      }
      const markFailure = (runtimeId: string, operation: string, error: unknown): void => {
        const current = healthByRuntime.get(runtimeId)
        if (!current) return
        const at = nowIso()
        healthByRuntime.set(runtimeId, {
          ...current,
          state: 'degraded',
          failureCount: current.failureCount + 1,
          lastFailure: {
            at,
            operation,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      const initialSnapshots = await Promise.all(connections.map(({ connection }) => connection.getSnapshot()))
      const initialSnapshotObjects = initialSnapshots.flatMap(snapshot => snapshot.objects)
      const initialDuplicates = duplicateObjectIds(initialSnapshotObjects)
      if (initialDuplicates.length > 0) {
        await Promise.allSettled(connections.map(({ connection }) => connection.close()))
        throw new Error(`duplicate runtime object ids from runtimes: ${initialDuplicates.join(', ')}`)
      }
      try {
        await Promise.all(connections.flatMap(({ connection }) =>
          connection.observeInitialSnapshot ? [connection.observeInitialSnapshot(initialSnapshotObjects)] : []))
      } catch (error) {
        await Promise.allSettled(connections.map(({ connection }) => connection.close()))
        throw error
      }
      const commandTargets = new Map(connections.flatMap(target =>
        capabilityIds(target.adapter.capabilities, 'command').map(route => [route, target] as const)))
      const realtimeInputTargets = new Map(connections.flatMap(target =>
        (target.adapter.realtimeInputTypes ?? []).map(route => [route, target] as const)))
      const queryTargets = new Map(connections.flatMap(target =>
        capabilityIds(target.adapter.capabilities, 'query').map(route => [route, target] as const)))
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
        markHealthy(adapter.id)
        for (const handler of handlers) handler(emission)
      }))

      const getSnapshot = async (): Promise<PackRuntimeSnapshot> => {
        const results = await Promise.allSettled(connections.map(({ connection }) => connection.getSnapshot()))
        results.forEach((result, index) => {
          if (result.status === 'rejected') markFailure(connections[index]!.adapter.id, 'get-snapshot', result.reason)
          else markHealthy(connections[index]!.adapter.id)
        })
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
        const snapshots = results.map(result => {
          if (result.status === 'rejected') throw result.reason
          return result.value
        })
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
        try {
          const result = await target.connection.sendCommand(command)
          markHealthy(target.adapter.id)
          return result
        } catch (error) {
          markFailure(target.adapter.id, command.kind, error)
          throw error
        }
      }

      const receiveRealtimeInput = async (input: PackRuntimeRealtimeInput): Promise<void> => {
        const target = realtimeInputTargets.get(input.type)
        if (!target) throw new Error(`no pack runtime accepts realtime input type: ${input.type}`)
        if (!target.connection.receiveRealtimeInput) throw new Error(`pack runtime cannot receive realtime input type: ${input.type}`)
        try {
          await target.connection.receiveRealtimeInput(input)
          markHealthy(target.adapter.id)
        } catch (error) {
          markFailure(target.adapter.id, input.type, error)
          throw error
        }
      }

      const commandEventHistory = (command: CommandEnvelope) => {
        const target = commandTargets.get(command.kind)
        return target?.adapter.commandEventHistory?.[command.kind] ?? 'record'
      }

      const invokeQuery = async (query: PackRuntimeQuery): Promise<unknown> => {
        const target = queryTargets.get(query.capabilityId)
        if (!target) {
          throw new Error(`no active Pack Runtime declares query Capability: ${query.capabilityId}`)
        }
        try {
          const result = await target.connection.invokeQuery(query)
          markHealthy(target.adapter.id)
          return result
        } catch (error) {
          markFailure(target.adapter.id, query.capabilityId, error)
          throw error
        }
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
        invokeQuery,
        observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
          const observations = await Promise.allSettled(connections.map(({ connection }) => connection.observeCommittedEvents(events)))
          observations.forEach((result, index) => {
            if (result.status === 'rejected') {
              markFailure(connections[index]!.adapter.id, 'observe-committed-events', result.reason)
              console.error(`pack runtime ${connections[index]!.adapter.id} failed to observe committed events:`, result.reason)
            } else {
              markHealthy(connections[index]!.adapter.id)
            }
          })
        },
        setClock: async (clock): Promise<void> => {
          const results = await Promise.allSettled(connections.map(({ connection }) => connection.setClock(clock)))
          results.forEach((result, index) => {
            if (result.status === 'rejected') markFailure(connections[index]!.adapter.id, 'set-clock', result.reason)
            else markHealthy(connections[index]!.adapter.id)
          })
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (failures.length > 0) throw new AggregateError(failures.map(failure => failure.reason), 'one or more Pack Runtimes rejected the simulation clock')
        },
        health: (): ReadonlyArray<PackRuntimeHealth> => [...healthByRuntime.values()]
          .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId)),
        close: async (): Promise<void> => {
          for (const unsubscribe of unsubscribes) unsubscribe()
          handlers.clear()
          const results = await Promise.allSettled(connections.map(({ connection }) => connection.close()))
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (failures.length > 0) throw new AggregateError(failures.map(failure => failure.reason), 'one or more Pack Runtimes failed to close')
        },
      }
    },
  }
}
